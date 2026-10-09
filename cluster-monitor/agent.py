"""副节点的只读快照接口（跑在副节点上）。

- 只有 GET /snapshot，必须带 Authorization: Bearer 令牌。
- 只监听 AGENT_BIND 指定的地址。建议填副节点的内网（WireGuard）地址，不要填 0.0.0.0。
- 不 SSH，不执行外部输入。只读 /proc、docker ps、docker logs，再做一次本机健康检查。
- 采集放在后台线程里，每隔 AGENT_INTERVAL_SECONDS 秒做一次；请求来了直接返回最近一次的结果，
  所以 docker 偶尔慢也不会让主节点等到超时。
- 读不到的值是 null，绝不补默认值。
"""
import os
import sys
import threading
import time
from http.server import ThreadingHTTPServer

import common
import metrics


def load_settings(env=None):
    env = dict(os.environ if env is None else env)
    return {
        'bind': (env.get('AGENT_BIND') or '').strip() or '127.0.0.1',
        'port': int(env.get('AGENT_PORT', '8898')),
        'token': common.require_token(env.get('AGENT_TOKEN', ''), 'AGENT_TOKEN'),
        'interval': max(2, int(env.get('AGENT_INTERVAL_SECONDS', '5'))),
        'disk_path': env.get('AGENT_DISK_PATH', '/'),
        'expect_containers': common.split_list(env.get('AGENT_EXPECT_CONTAINERS', '')),
        'sub2api_health_url': env.get('AGENT_SUB2API_HEALTH_URL', ''),
        'request_container': env.get('AGENT_REQUEST_CONTAINER', ''),
    }


class SnapshotSource:
    """后台采集，请求只读最近一次的结果。CPU 占用率是两次采样之间的变化，所以采集要定时进行。"""

    def __init__(self, settings, *, clock=time.time, sources=None):
        self._settings = settings
        self._clock = clock
        self._sources = sources or metrics.default_sources()
        self._cpu = metrics.CpuSampler()
        self._lock = threading.Lock()
        self._latest = None

    def collect_once(self):
        now_ms = int(self._clock() * 1000)
        node = metrics.node_facts(self._settings, self._cpu, now_ms, self._sources)
        snapshot = {'node': node}
        with self._lock:
            self._latest = snapshot
        return snapshot

    def latest(self):
        with self._lock:
            return self._latest

    def payload(self):
        """最近一次的结果，外加「这份结果已经有多久了」。年龄在本机算，不依赖两台机器的时钟。"""
        latest = self.latest()
        if latest is None:
            return None
        served = int(self._clock() * 1000)
        return {'node': latest['node'], 'servedAgeMs': max(0, served - latest['node']['collectedAt'])}

    def run_forever(self, stop):
        while not stop.is_set():
            try:
                self.collect_once()
            except Exception as error:  # 单轮失败只记一行，下一轮再来
                print(f'[agent] 采集这一轮出错：{type(error).__name__}', file=sys.stderr)
            stop.wait(self._settings['interval'])


def snapshot_route(source):
    def route():
        payload = source.payload()
        if payload is None:
            return 503, {'error': 'not_ready'}
        return 200, payload
    return route


def main():
    settings = load_settings()
    source = SnapshotSource(settings)
    try:
        source.collect_once()
    except Exception as error:
        print(f'[agent] 首次采集出错：{type(error).__name__}', file=sys.stderr)
    stop = threading.Event()
    threading.Thread(target=source.run_forever, args=(stop,), daemon=True).start()
    handler = common.make_handler({'/snapshot': snapshot_route(source)}, settings['token'])
    server = ThreadingHTTPServer((settings['bind'], settings['port']), handler)
    server.daemon_threads = True
    print(f"[agent] 监听 {settings['bind']}:{settings['port']}，每 {settings['interval']} 秒采集一次")
    try:
        server.serve_forever()
    finally:
        stop.set()


if __name__ == '__main__':
    main()
