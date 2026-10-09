"""主机指标读取（只读，只用标准库）。

读不到的值一律是 None，不编任何“看起来正常”的默认值：
页面显示「取不到」，报警逻辑把它当成问题处理（或者干脆跳过，绝不当成正常）。
"""
import http.client
import os
import re
import subprocess
import urllib.request

PROC_STAT = '/proc/stat'
PROC_MEMINFO = '/proc/meminfo'
SYSFS_NET = '/sys/class/net'
REQUEST_LOG_LINE = 'http request completed'
PING_TIME = re.compile(r'time[=<]\s*([0-9.]+)\s*ms')

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


def count_requests(container, since='60s', run=subprocess.run):
    """最近一段时间里，容器日志里有多少条“请求完成”的记录。"""
    done = run(['docker', 'logs', '--since', since, container],
               capture_output=True, text=True, timeout=10)
    if done.returncode != 0:
        raise OSError('docker logs 失败')
    text = done.stdout + done.stderr
    return sum(1 for line in text.splitlines() if REQUEST_LOG_LINE in line)


def probe_http(url, timeout=2.0, opener=_LOCAL_OPENER):
    """服务正常回应返回 True；连不上、超时、返回错误、回了不是 HTTP 的东西，都返回 False。
    这是“不通”，不是“取不到”。"""
    try:
        with opener.open(url, timeout=timeout) as resp:
            return 200 <= resp.status < 300
    except (OSError, ValueError, http.client.HTTPException):
        return False


def ping_peer(ip, run=subprocess.run):
    """ping 的退出码：0 = 有回复，1 = 没有回复（不通），其他 = ping 本身出错（参数、权限），返回 None。
    有回复时，往返时间能解析就给出来，解析不出（比如系统是中文）也照样算通。"""
    try:
        done = run(['ping', '-c', '1', '-W', '2', ip], capture_output=True, text=True, timeout=6)
    except READ_ERRORS:
        return None
    if done.returncode == 0:
        match = PING_TIME.search(done.stdout)
        return {'ok': True, 'rttMs': float(match.group(1)) if match else None}
    if done.returncode == 1:
        return {'ok': False, 'rttMs': None}
    return None


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
