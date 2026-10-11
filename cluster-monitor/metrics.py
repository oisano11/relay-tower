"""主机指标读取（只读，只用标准库）。

读不到的值一律是 None，不编任何“看起来正常”的默认值：
页面显示「取不到」，报警逻辑把它当成问题处理（或者干脆跳过，绝不当成正常）。
"""
import calendar
import fnmatch
import http.client
import os
import re
import socket
import statistics
import subprocess
import time
import urllib.request

PROC_STAT = '/proc/stat'
PROC_MEMINFO = '/proc/meminfo'
PROC_NET_ROUTE = '/proc/net/route'
SYSFS_NET = '/sys/class/net'
# 网卡名只允许这些字符（内核的上限是 15 个字符），免得配置里的名字被拼成别的路径
IFACE_NAME = re.compile(r'^[A-Za-z0-9_.:@-]{1,15}$')
# 每个请求结束时，Sub2API 写一行「请求完成」，只数这一行。
# 同一个请求还会写别的日志行（比如转发上游时），里面也带着 path，数它们会重复计数。
REQUEST_DONE_MARK = 'http request completed'
# 客户调用的接口都在 /v1/ 下。控制台和网页自己的请求（/api/v1/ 等）也写进同一份日志，不能算进客户请求。
# 两种日志格式写法不同：console 格式是 "path": "/v1/…"（冒号后有空格），json 格式是 "path":"/v1/…"。
CUSTOMER_PATH = re.compile(r'"path":\s?"/v1/')
# 「请求完成」那一行里的状态码和耗时（毫秒）。两种日志格式冒号后面有没有空格都认。
STATUS_CODE = re.compile(r'"status_code":\s?(\d{3})')
LATENCY_MS = re.compile(r'"latency_ms":\s?(\d+)')
# 客户请求看近 5 分钟：接了多少、失败多少、一般多久回完
REQUEST_WINDOW_SECONDS = 300
# 只读日志末尾这么多行。docker logs 只带 --since 时会从头扫整份日志：
# 线上 700 多 MB 的日志要 17 秒，还会占满一个 CPU 核。带上 --tail 就只读末尾。
# 先读 2000 行（平时 5 分钟的日志远少于这个数）；不够再读 20000 行；还不够就当成取不到。
REQUEST_TAIL_STEPS = (2000, 20000)

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


def docker_log_time(line):
    """docker logs --timestamps 加在每行开头的时间（UTC），换成秒。认不出来返回 None。"""
    try:
        return calendar.timegm(time.strptime(line[:19], '%Y-%m-%dT%H:%M:%S'))
    except (ValueError, OverflowError):
        return None


def read_recent_log(container, window, run=subprocess.run, tails=REQUEST_TAIL_STEPS):
    """近 window 秒的日志（每行开头带 docker 记下的时间）。只读末尾：先少读，不够再多读。
    读满了还没读完这段时间，说明这段时间的日志太多、数不全，抛错（由 safe 变成 None）。"""
    for tail in tails:
        done = run(['docker', 'logs', '--timestamps', '--tail', str(tail), '--since', f'{window}s', container],
                   capture_output=True, text=True, timeout=10)
        if done.returncode != 0:
            raise OSError('docker logs 失败')
        lines = done.stdout.splitlines() + done.stderr.splitlines()
        if len(lines) < tail:
            return lines
    raise ValueError('这段时间的日志太多，只读末尾会数不全')


def request_stats(container, run=subprocess.run, now=time.time, window=REQUEST_WINDOW_SECONDS, tails=REQUEST_TAIL_STEPS):
    """近 window 秒客户调用（路径以 /v1/ 开头）的情况，每个请求只数它的「请求完成」那一行：
    - total：接了多少个；
    - failed：失败多少个（状态码 5xx，服务器或上游出错；4xx 是客户自己的问题，比如 Key 不对，不算）；
    - medianLatencyMs：成功的请求一般多久回完（中位数，毫秒）；一个成功的都没有就是 None；
    - last60s：其中近 60 秒的条数（老版本的中转塔台只认这个数）。"""
    lines = read_recent_log(container, window, run=run, tails=tails)
    current = now()
    total = failed = last60 = 0
    undated = False
    latencies = []
    for line in lines:
        if REQUEST_DONE_MARK not in line or not CUSTOMER_PATH.search(line):
            continue
        total += 1
        at = docker_log_time(line)
        if at is None:
            undated = True
        elif current - at <= 60:
            last60 += 1
        status = STATUS_CODE.search(line)
        code = int(status.group(1)) if status else None
        if code is None:
            continue
        if code >= 500:
            failed += 1
        elif code < 400:
            latency = LATENCY_MS.search(line)
            if latency:
                latencies.append(int(latency.group(1)))
    return {
        'windowSeconds': window,
        'total': total,
        'failed': failed,
        'medianLatencyMs': round(statistics.median(latencies)) if latencies else None,
        'last60s': None if undated else last60,
    }


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
    if not IFACE_NAME.match(iface or ''):
        raise ValueError('网卡名不对')

    def read(name):
        with open(os.path.join(base, iface, 'statistics', name)) as f:
            return int(f.read().strip())
    return {'rxBytes': read('rx_bytes'), 'txBytes': read('tx_bytes')}


def default_route_iface(path=PROC_NET_ROUTE):
    """默认路由走的网卡，也就是连外网的那块。有几条默认路由时，取优先级最高（metric 最小）的。"""
    best = None
    with open(path) as f:
        next(f, None)  # 表头
        for line in f:
            fields = line.split()
            if len(fields) < 8:
                continue
            iface, destination, flags, metric, mask = fields[0], fields[1], int(fields[3], 16), int(fields[6]), fields[7]
            if destination == '00000000' and mask == '00000000' and flags & 0x1:  # 0x1：这条路由是启用的
                if best is None or metric < best[1]:
                    best = (iface, metric)
    if best is None:
        raise ValueError('没有默认路由')
    return best[0]


def read_boot_time(path=PROC_STAT):
    """这台机器开机的时间（秒）。"""
    with open(path) as f:
        for line in f:
            if line.startswith('btime '):
                return int(line.split()[1])
    raise ValueError('/proc/stat 里没有开机时间')


def read_net(iface=None, base=SYSFS_NET, route_path=PROC_NET_ROUTE, stat_path=PROC_STAT):
    """连外网那块网卡开机以来收、发的总字节数，外加开机时间。
    每天、每月用了多少，由中转塔台每分钟记一次、前后相减算出来；重启后计数器会清零，塔台靠开机时间认出来。
    iface 不填就用默认路由走的那块网卡。"""
    name = iface or default_route_iface(route_path)
    counters = read_iface_counters(name, base)
    return {'iface': name, 'rxBytes': counters['rxBytes'], 'txBytes': counters['txBytes'], 'bootAt': read_boot_time(stat_path)}


def read_backups(directory, pattern='*.dump'):
    """备份目录里一共几份、最新那份的时间（毫秒）和大小。只看文件名和属性，不读内容。
    隐藏文件（备份到一半的临时文件、锁文件）不算。目录读不到就抛错（由 safe 变成 None，界面显示「取不到」）；
    一份都没有时 count 是 0、latestAt 是 None。"""
    newest = None
    count = 0
    with os.scandir(directory) as entries:
        for entry in entries:
            if entry.name.startswith('.') or not fnmatch.fnmatchcase(entry.name, pattern):
                continue
            if not entry.is_file(follow_symlinks=False):
                continue
            info = entry.stat(follow_symlinks=False)
            count += 1
            if newest is None or info.st_mtime > newest.st_mtime:
                newest = info
    return {
        'count': count,
        'latestAt': int(newest.st_mtime * 1000) if newest else None,
        'latestBytes': newest.st_size if newest else None,
    }


def default_sources(run=subprocess.run):
    """真实的读取函数表。测试时换成假的。"""
    return {
        'memory': safe(read_memory),
        'disk': safe(read_disk),
        'load': safe(read_load),
        'containers': lambda expected: safe(read_containers)(expected, run=run),
        'probe': probe_http,
        'requests': lambda container: safe(request_stats)(container, run=run),
        'net': safe(read_net),
        'backup': safe(read_backups),
    }


def node_facts(settings, cpu, now_ms, sources):
    """一台机器读到的事实：读到的是数字，读不到的是 None。settings 只用到下面几个键。"""
    health_url = settings.get('sub2api_health_url')
    container = settings.get('request_container')
    requests = sources['requests'](container) if container else None
    backup_dir = settings.get('backup_dir')
    return {
        'reachable': True,
        'collectedAt': now_ms,
        'cpuPercent': cpu.percent(),
        'memory': sources['memory'](),
        'disk': sources['disk'](settings.get('disk_path') or '/'),
        'loadAvg': sources['load'](),
        'containers': sources['containers'](settings.get('expect_containers') or []),
        'sub2apiOk': sources['probe'](health_url) if health_url else None,
        'requests': requests,
        # 老版本的中转塔台只认近 1 分钟的条数，先留着，两边不用同时升级
        'requests60s': requests['last60s'] if requests else None,
        'net': sources['net'](settings.get('net_iface') or None),
        # 数据库备份放在哪台机器上，就由哪台报告。没配置备份目录就是 False，界面不显示这一项。
        'backupConfigured': bool(backup_dir),
        'backup': sources['backup'](backup_dir, settings.get('backup_pattern') or '*.dump') if backup_dir else None,
    }
