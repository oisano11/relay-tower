"""主机指标读取（只读，只用标准库）。

读不到的值一律是 None，不编任何“看起来正常”的默认值：
页面显示「取不到」，报警逻辑把它当成问题处理（或者干脆跳过，绝不当成正常）。
"""
import http.client
import os
import re
import socket
import subprocess
import time
import urllib.request

PROC_STAT = '/proc/stat'
PROC_MEMINFO = '/proc/meminfo'
SYSFS_NET = '/sys/class/net'
# 每个请求结束时，Sub2API 写一行「请求完成」，只数这一行。
# 同一个请求还会写别的日志行（比如转发上游时），里面也带着 path，数它们会重复计数。
REQUEST_DONE_MARK = 'http request completed'
# 客户调用的接口都在 /v1/ 下。控制台和网页自己的请求（/api/v1/ 等）也写进同一份日志，不能算进客户请求。
# 两种日志格式写法不同：console 格式是 "path": "/v1/…"（冒号后有空格），json 格式是 "path":"/v1/…"。
CUSTOMER_PATH = re.compile(r'"path":\s?"/v1/')
# 只读日志末尾这么多行。docker logs 只带 --since 时会从头扫整份日志：
# 线上 700 多 MB 的日志要 17 秒，还会占满一个 CPU 核。带上 --tail 就只读末尾，0.1 秒左右。
REQUEST_TAIL_LINES = 5000

# 读取失败时可能抛出的异常，都只表示“这一项取不到”
READ_ERRORS = (OSError, ValueError, KeyError, IndexError, ZeroDivisionError, subprocess.SubprocessError)

# 探测本机服务时不走代理（环境变量里的 *_proxy 会让本机请求绕路）
_LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def safe(read):
    """包一层：读取失败返回 None。"""
    def wrapper(*args, **kwargs):
        try:
            return read(*args, **kwargs)
        except READ_ERRORS:
            return None
    return wrapper


def read_cpu_totals(path=PROC_STAT):
    """返回 (空闲时间, 总时间)，单位是内核时钟滴答数。"""
    with open(path) as f:
        fields = f.readline().split()
    if not fields or fields[0] != 'cpu':
        raise ValueError('/proc/stat 格式不对')
    values = [int(v) for v in fields[1:9]]  # user nice system idle iowait irq softirq steal
    return values[3] + values[4], sum(values)


class CpuSampler:
    """CPU 占用率是两次采样之间的差值，所以第一次返回 None。"""

    def __init__(self, read=read_cpu_totals):
        self._read = read
        self._last = None

    def percent(self):
        try:
            idle, total = self._read()
        except READ_ERRORS:
            self._last = None
            return None
        previous, self._last = self._last, (idle, total)
        if previous is None:
            return None
        span = total - previous[1]
        if span <= 0:
            return None
        return round(100.0 * (1 - (idle - previous[0]) / span), 1)


def read_memory(path=PROC_MEMINFO):
    values = {}
    with open(path) as f:
        for line in f:
            key, _, rest = line.partition(':')
            if key in ('MemTotal', 'MemAvailable'):
                values[key] = int(rest.split()[0])  # 单位是 kB
    total = values['MemTotal']
    used = total - values['MemAvailable']
    return {
        'totalMb': round(total / 1024),
        'usedMb': round(used / 1024),
        'percent': round(100.0 * used / total, 1),
    }


def read_disk(path='/'):
    st = os.statvfs(path)
    total = st.f_blocks * st.f_frsize
    used = (st.f_blocks - st.f_bfree) * st.f_frsize
    avail = st.f_bavail * st.f_frsize
    # 和 df 一样：占用率 = 已用 /（已用 + 普通用户可用）
    return {
        'totalGb': round(total / 1024 ** 3, 1),
        'usedGb': round(used / 1024 ** 3, 1),
        'percent': round(100.0 * used / (used + avail), 1),
    }


def read_load():
    return [round(v, 2) for v in os.getloadavg()]


def read_containers(expected, run=subprocess.run):
    """期望中的容器各自的状态；没有的标成 missing。docker 不可用时抛错，由 safe 变成 None。"""
    if not expected:
        return []
    done = run(['docker', 'ps', '-a', '--format', '{{.Names}}\t{{.State}}'],
               capture_output=True, text=True, timeout=8)
    if done.returncode != 0:
        raise OSError('docker ps 失败')
    states = {}
    for line in done.stdout.splitlines():
        name, _, state = line.partition('\t')
        states[name.strip()] = state.strip()
    return [{'name': name, 'state': states.get(name, 'missing')} for name in expected]


def count_requests(container, since='60s', run=subprocess.run, tail=REQUEST_TAIL_LINES):
    """最近一段时间里，客户调用（路径以 /v1/ 开头）的请求条数：每个请求只数它的「请求完成」那一行。
    只读日志末尾 tail 行，再按时间筛出这段时间的。筛完还剩满 tail 行，
    说明这段时间的日志比 tail 还多、数不全，当成取不到（抛错，由 safe 变成 None）。"""
    done = run(['docker', 'logs', '--tail', str(tail), '--since', since, container],
               capture_output=True, text=True, timeout=10)
    if done.returncode != 0:
        raise OSError('docker logs 失败')
    lines = done.stdout.splitlines() + done.stderr.splitlines()
    if len(lines) >= tail:
        raise ValueError('这段时间的日志太多，只读末尾会数不全')
    return sum(1 for line in lines if REQUEST_DONE_MARK in line and CUSTOMER_PATH.search(line))


def probe_http(url, timeout=2.0, opener=_LOCAL_OPENER):
    """服务正常回应返回 True；连不上、超时、返回错误、回了不是 HTTP 的东西，都返回 False。
    这是“不通”，不是“取不到”。"""
    try:
        with opener.open(url, timeout=timeout) as resp:
            return 200 <= resp.status < 300
    except (OSError, ValueError, http.client.HTTPException):
        return False


def probe_tcp(host, port, source_ip=None, timeout=2.0, connect=socket.create_connection):
    """用 TCP 连一下对端的端口，判断两台之间的隧道通不通。不需要任何特殊权限。
    - 连上了，或者被对面明确拒绝（对面回了 RST）：包已经到了对面，返回 ok=True。
    - 超时、主机或网络不可达、本机没有这个隧道地址：返回 ok=False。
    - 地址解析失败（多半是配置写错）：返回 None，表示取不到。
    source_ip 填本机在隧道上的地址：本机没有这个地址时，绑定就失败，判为不通。"""
    started = time.monotonic()
    try:
        sock = connect((host, port), timeout=timeout, source_address=(source_ip, 0) if source_ip else None)
    except ConnectionRefusedError:
        return {'ok': True, 'rttMs': round((time.monotonic() - started) * 1000, 2)}
    except socket.gaierror:
        return None
    except OSError:
        return {'ok': False, 'rttMs': None}
    sock.close()
    return {'ok': True, 'rttMs': round((time.monotonic() - started) * 1000, 2)}


def read_iface_counters(iface, base=SYSFS_NET):
    def read(name):
        with open(os.path.join(base, iface, 'statistics', name)) as f:
            return int(f.read().strip())
    return {'rxBytes': read('rx_bytes'), 'txBytes': read('tx_bytes')}


def default_sources(run=subprocess.run):
    """真实的读取函数表。测试时换成假的。"""
    return {
        'memory': safe(read_memory),
        'disk': safe(read_disk),
        'load': safe(read_load),
        'containers': lambda expected: safe(read_containers)(expected, run=run),
        'probe': probe_http,
        'requests': lambda container: safe(count_requests)(container, run=run),
    }


def node_facts(settings, cpu, now_ms, sources):
    """一台机器读到的事实：读到的是数字，读不到的是 None。settings 只用到下面几个键。"""
    health_url = settings.get('sub2api_health_url')
    container = settings.get('request_container')
    return {
        'reachable': True,
        'collectedAt': now_ms,
        'cpuPercent': cpu.percent(),
        'memory': sources['memory'](),
        'disk': sources['disk'](settings.get('disk_path') or '/'),
        'loadAvg': sources['load'](),
        'containers': sources['containers'](settings.get('expect_containers') or []),
        'sub2apiOk': sources['probe'](health_url) if health_url else None,
        'requests60s': sources['requests'](container) if container else None,
    }
