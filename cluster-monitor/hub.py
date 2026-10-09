"""双机集群中台（跑在主节点上）：采集两台机器的事实，通过一个只读接口提供。

- 接口只有 GET /api/status，必须带 Authorization: Bearer 令牌。没有页面，没有 CORS，不接受 POST。
- HUB_BIND 必须设置，填中转塔台容器能访问的 Docker 网关地址，不能是 0.0.0.0。
  中转塔台（Docker 容器）通过这个地址取数，外网访问不到。
- 副节点的数据由它上面的 agent.py 提供，这里主动去拉。不 SSH，不用 root 账号。
  注意：运行账号要在 docker 组里才能读容器状态，而 docker 组本身等同于 root 权限。
- 两台之间的隧道用 TCP 连一下副节点的 agent 端口判断（不用 ping，不需要特殊权限）。
- 读不到的值是 null，绝不补默认值。
"""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer

import common
import metrics

WORKER_TIMEOUT_SECONDS = 3.0


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """副节点的回应如果是跳转，不跟过去：令牌不能被带到别的地址上。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# 取副节点数据：不跟跳转，不走代理（环境变量里的 *_proxy 不能把令牌带出去）
WORKER_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def link_settings(worker_url, env):
    """隧道检查：连副节点 agent 的地址和端口。WG_LOCAL_IP 是主节点在隧道上的地址（填了就从它发出去）。"""
    peer_ip, peer_port = '', None
    if worker_url:
        parts = urllib.parse.urlsplit(worker_url)
        peer_ip = parts.hostname or ''
        peer_port = parts.port or (443 if parts.scheme == 'https' else 80)
    return {
        'peer_ip': peer_ip,
        'peer_port': peer_port,
        'source_ip': (env.get('WG_LOCAL_IP') or '').strip(),
        'iface': (env.get('WG_IFACE') or 'wg0').strip(),
    }


def load_settings(env=None):
    """所有地址、名字、令牌都来自环境变量，代码里不写任何真实地址。"""
    env = dict(os.environ if env is None else env)
    token = common.require_token(env.get('HUB_TOKEN', ''), 'HUB_TOKEN')
    bind = (env.get('HUB_BIND') or '').strip()
    if not bind:
        raise SystemExit('HUB_BIND 必须设置：填中转塔台容器能访问的 Docker 网关地址')
    if bind in ('0.0.0.0', '::'):
        raise SystemExit('HUB_BIND 不能是 0.0.0.0 或 ::，那样中台会暴露在所有网卡上')
    worker_url = (env.get('WORKER_AGENT_URL') or '').strip()
    worker_token = (env.get('WORKER_AGENT_TOKEN') or '').strip()
    if worker_url:
        if not worker_url.startswith(('http://', 'https://')):
            raise SystemExit('WORKER_AGENT_URL 要以 http:// 或 https:// 开头')
        common.require_token(worker_token, 'WORKER_AGENT_TOKEN')
    return {
        'bind': bind,
        'port': int(env.get('HUB_PORT', '8899')),
        'token': token,
        'interval': max(5, int(env.get('HUB_INTERVAL_SECONDS', '10'))),
        'master': {
            'label': env.get('MASTER_LABEL', '主节点'),
            'disk_path': env.get('MASTER_DISK_PATH', '/'),
            'expect_containers': common.split_list(env.get('MASTER_EXPECT_CONTAINERS', '')),
            'sub2api_health_url': env.get('MASTER_SUB2API_HEALTH_URL', ''),
            'request_container': env.get('MASTER_REQUEST_CONTAINER', ''),
        },
        'worker': {
            'label': env.get('WORKER_LABEL', '副节点'),
            'agent_url': worker_url,
            'agent_token': worker_token,
            'timeout': WORKER_TIMEOUT_SECONDS,
        },
        'link': link_settings(worker_url, env),
    }


def empty_node(label, reachable, error, now_ms):
    """拿不到这台机器的数据时用：所有指标都是 None，reachable 说明是「离线」还是「没配置」。"""
    return {
        'label': label,
        'reachable': reachable,
        'error': error,
        'collectedAt': now_ms,
        'cpuPercent': None,
        'memory': None,
        'disk': None,
        'loadAvg': None,
        'containers': None,
        'sub2apiOk': None,
        'requests60s': None,
    }


def fetch_worker(worker, now_ms, opener=WORKER_OPENER):
    label = worker['label']
    if not worker['agent_url']:
        return empty_node(label, None, '未配置副节点地址', now_ms)
    try:
        request = urllib.request.Request(
            worker['agent_url'].rstrip('/') + '/snapshot',
            headers={'Authorization': 'Bearer ' + worker['agent_token']},
        )
        with opener.open(request, timeout=worker['timeout']) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
    except Exception as error:  # 网络错误、超时、跳转、回应不是 JSON 都算「离线」
        if isinstance(error, urllib.error.HTTPError):
            error.close()
        return empty_node(label, False, f'{type(error).__name__}: {str(error)[:160]}', now_ms)
    node = payload.get('node') if isinstance(payload, dict) else None
    age = payload.get('servedAgeMs') if isinstance(payload, dict) else None
    if not isinstance(node, dict):
        return empty_node(label, False, '副节点返回的数据格式不对', now_ms)
    if isinstance(age, bool) or not isinstance(age, (int, float)) or age < 0:
        return empty_node(label, False, '副节点返回的数据缺少时间信息', now_ms)
    # 采集时间用中台的时钟推算：副节点的时钟快或慢，都不影响「数据过没过期」的判断
    return dict(node, label=label, reachable=True, collectedAt=now_ms - int(age))


def read_link(link, now_ms, probe=metrics.probe_tcp, iface_reader=metrics.read_iface_counters):
    """两台之间的隧道：TCP 连一下副节点的 agent 端口。检查本身出错就是 None（取不到）。"""
    counters = metrics.safe(iface_reader)(link['iface']) or {}
    base = {'rxBytes': counters.get('rxBytes'), 'txBytes': counters.get('txBytes'), 'collectedAt': now_ms}
    if not link['peer_ip']:
        return dict(base, ok=None, rttMs=None, error='未配置副节点地址')
    result = probe(link['peer_ip'], link['peer_port'], link['source_ip'] or None)
    if result is None:
        return dict(base, ok=None, rttMs=None, error='取不到（检查本身出错）')
    if not result['ok']:
        return dict(base, ok=False, rttMs=None, error='连不上副节点的端口（隧道可能断了，或副节点不通）')
    return dict(base, ok=True, rttMs=result['rttMs'], error=None)


class Collector:
    """后台每隔 interval 秒采一次；接口只返回最近一次的结果，不会每个请求都去读机器。"""

    def __init__(self, settings, *, clock=time.time, master_sources=None, fetch=fetch_worker, link_reader=read_link):
        self.settings = settings
        self._clock = clock
        self._sources = master_sources or metrics.default_sources()
        self._cpu = metrics.CpuSampler()
        self._fetch = fetch
        self._read_link = link_reader
        self._lock = threading.Lock()
        self._latest = None

    def collect_once(self):
        now_ms = int(self._clock() * 1000)
        label = self.settings['master']['label']
        # 每一部分单独保护：一项出错只让这一项变成「取不到」，不会让整轮采集作废
        try:
            master = dict(metrics.node_facts(self.settings['master'], self._cpu, now_ms, self._sources), label=label)
        except Exception as error:
            print(f'[hub] 主节点采集出错：{type(error).__name__}', file=sys.stderr)
            master = dict(empty_node(label, True, f'采集出错：{type(error).__name__}', now_ms))
        worker = self._fetch(self.settings['worker'], now_ms)
        try:
            link = self._read_link(self.settings['link'], now_ms)
        except Exception as error:
            print(f'[hub] 隧道检查出错：{type(error).__name__}', file=sys.stderr)
            link = {'ok': None, 'rttMs': None, 'rxBytes': None, 'txBytes': None,
                    'collectedAt': now_ms, 'error': f'采集出错：{type(error).__name__}'}
        snapshot = {
            'schemaVersion': 1,
            'collectedAt': now_ms,
            'intervalSeconds': self.settings['interval'],
            'nodes': {'master': master, 'worker': worker},
            'link': link,
        }
        with self._lock:
            self._latest = snapshot
        return snapshot

    def latest(self):
        with self._lock:
            return self._latest

    def run_forever(self, stop):
        while not stop.is_set():
            try:
                self.collect_once()
            except Exception as error:  # 单轮失败只记一行，下一轮再来
                print(f'[hub] 采集这一轮出错：{type(error).__name__}', file=sys.stderr)
            stop.wait(self.settings['interval'])


def status_route(collector):
    def route():
        latest = collector.latest()
        if latest is None:
            return 503, {'error': 'not_ready'}
        return 200, latest
    return route


def main():
    settings = load_settings()
    collector = Collector(settings)
    try:
        collector.collect_once()
    except Exception as error:
        print(f'[hub] 首次采集出错：{type(error).__name__}', file=sys.stderr)
    stop = threading.Event()
    threading.Thread(target=collector.run_forever, args=(stop,), daemon=True).start()
    handler = common.make_handler({'/api/status': status_route(collector)}, settings['token'])
    server = ThreadingHTTPServer((settings['bind'], settings['port']), handler)
    server.daemon_threads = True
    print(f"[hub] 监听 {settings['bind']}:{settings['port']}，每 {settings['interval']} 秒采集一次")
    try:
        server.serve_forever()
    finally:
        stop.set()


if __name__ == '__main__':
    main()
