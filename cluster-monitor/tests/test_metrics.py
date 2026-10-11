import errno
import http.client
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import metrics  # noqa: E402


def completed(returncode=0, stdout='', stderr=''):
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


def write_file(test, text):
    handle, path = tempfile.mkstemp()
    with os.fdopen(handle, 'w') as f:
        f.write(text)
    test.addCleanup(os.remove, path)
    return path


class FakeCpu:
    def __init__(self, value):
        self.value = value

    def percent(self):
        return self.value


class FakeResponse:
    def __init__(self, status=200):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeOpener:
    """假的 urllib 打开器：fn 返回回应，或者抛出异常。"""

    def __init__(self, fn):
        self.fn = fn

    def open(self, url, timeout=None):
        return self.fn(url, timeout)


def fake_connect(error):
    """假的连接函数：每次都抛出给定的异常，不发任何包。"""
    def connect(address, timeout=None, source_address=None):
        raise error
    return connect


class CpuTests(unittest.TestCase):
    def test_totals_are_idle_and_all_ticks(self):
        path = write_file(self, 'cpu  100 0 50 800 20 0 0 0 0 0\ncpu0 1 1 1 1\n')
        self.assertEqual(metrics.read_cpu_totals(path), (820, 970))

    def test_first_sample_has_no_percent_then_the_change_does(self):
        samples = iter([(820, 970), (900, 1070)])
        sampler = metrics.CpuSampler(read=lambda: next(samples))
        self.assertIsNone(sampler.percent())
        self.assertEqual(sampler.percent(), 20.0)  # 100 个滴答里 80 个空闲，忙 20%

    def test_unreadable_cpu_is_none_not_a_guess(self):
        def boom():
            raise OSError('no /proc')
        self.assertIsNone(metrics.CpuSampler(read=boom).percent())


class MemoryTests(unittest.TestCase):
    def test_percent_comes_from_total_and_available(self):
        path = write_file(self, 'MemTotal:       4194304 kB\nMemAvailable:   2097152 kB\n')
        self.assertEqual(metrics.read_memory(path), {'totalMb': 4096, 'usedMb': 2048, 'percent': 50.0})

    def test_missing_field_is_none(self):
        path = write_file(self, 'MemTotal:       4194304 kB\n')
        self.assertIsNone(metrics.safe(metrics.read_memory)(path))


class DiskTests(unittest.TestCase):
    def test_reads_a_real_directory(self):
        result = metrics.read_disk(tempfile.gettempdir())
        self.assertEqual(set(result), {'totalGb', 'usedGb', 'percent'})
        self.assertTrue(0 <= result['percent'] <= 100)


class ContainerTests(unittest.TestCase):
    def test_expected_names_get_their_state_and_missing_ones_say_so(self):
        def run(*args, **kwargs):
            return completed(stdout='sub2api\trunning\nsub2api-redis\texited\n')
        self.assertEqual(metrics.read_containers(['sub2api', 'sub2api-postgres', 'sub2api-redis'], run=run), [
            {'name': 'sub2api', 'state': 'running'},
            {'name': 'sub2api-postgres', 'state': 'missing'},
            {'name': 'sub2api-redis', 'state': 'exited'},
        ])

    def test_docker_failure_is_none(self):
        def run(*args, **kwargs):
            return completed(returncode=1)
        self.assertIsNone(metrics.safe(metrics.read_containers)(['sub2api'], run=run))

    def test_docker_not_installed_is_none(self):
        def run(*args, **kwargs):
            raise FileNotFoundError('docker')
        self.assertIsNone(metrics.safe(metrics.read_containers)(['sub2api'], run=run))

    def test_nothing_expected_skips_docker(self):
        def run(*args, **kwargs):
            raise AssertionError('docker should not run')
        self.assertEqual(metrics.read_containers([], run=run), [])


NOW = 1700000000  # 测试里的「现在」（秒）


def stamped(text, ago=10):
    """模拟 docker logs --timestamps：每行开头是 docker 记下的 UTC 时间（纳秒精度）。"""
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(NOW - ago)) + '.123456789Z ' + text


def done_line(path='/v1/chat/completions', status=200, latency=1000, compact=False):
    if compact:
        return '{"level":"info","msg":"http request completed","path":"%s","status_code":%d,"latency_ms":%d}' % (path, status, latency)
    return 'x INFO http request completed\t{"path": "%s", "status_code": %d, "latency_ms": %d, "path": "%s"}' % (path, status, latency, path)


def stats(log, **kwargs):
    def run(*args, **kw):
        return completed(stdout=log)
    return metrics.request_stats('sub2api', run=run, now=lambda: NOW, **kwargs)


class CustomerRequestTests(unittest.TestCase):
    def test_only_customer_calls_are_counted_and_each_request_once(self):
        # 真实日志里一条请求的 path 字段出现两次；控制台的管理接口（/api/v1）不算客户请求
        log = '\n'.join([
            stamped(done_line('/v1/chat/completions')),
            stamped(done_line('/api/v1/auth/me')),
            stamped(done_line('/v1/messages')),
            stamped('noise line without any request'),
        ])
        self.assertEqual(stats(log)['total'], 2)

    def test_the_compact_json_log_format_is_counted_too(self):
        # 另一台机器用 json 格式：冒号后面没有空格
        log = '\n'.join([
            stamped(done_line('/v1/responses', status=502, compact=True)),
            stamped(done_line('/api/v1/auth/me', compact=True)),
            stamped(done_line('/v1/responses', latency=4000, compact=True)),
        ])
        result = stats(log)
        self.assertEqual((result['total'], result['failed'], result['medianLatencyMs']), (2, 1, 4000))

    def test_other_log_lines_of_the_same_request_are_not_counted(self):
        # 同一个请求转发上游时也会写带 path 的日志，只有「请求完成」那一行算数
        log = '\n'.join([
            stamped('x WARN upstream request failed\t{"path": "/v1/chat/completions", "status_code": 502}'),
            stamped('x INFO account selected\t{"path": "/v1/chat/completions"}'),
            stamped(done_line('/v1/chat/completions')),
        ])
        result = stats(log)
        self.assertEqual((result['total'], result['failed']), (1, 0))

    def test_server_errors_fail_client_errors_do_not_and_the_typical_time_is_the_median(self):
        log = '\n'.join([
            stamped(done_line(status=200, latency=1000)),
            stamped(done_line(status=200, latency=3000)),
            stamped(done_line(status=200, latency=900000)),  # 一个特别慢的不会把「一般多久」拉上去
            stamped(done_line(status=502, latency=25000)),
            stamped(done_line(status=503, latency=100)),
            stamped(done_line(status=401, latency=5)),       # Key 不对：客户自己的问题，不算失败，也不算进耗时
            stamped(done_line(status=429, latency=7)),
        ])
        self.assertEqual(stats(log), {'windowSeconds': 300, 'total': 7, 'failed': 2, 'medianLatencyMs': 3000, 'last60s': 7})

    def test_no_successful_request_means_no_typical_time(self):
        result = stats(stamped(done_line(status=502)))
        self.assertEqual((result['total'], result['failed'], result['medianLatencyMs']), (1, 1, None))
        self.assertEqual(stats(''), {'windowSeconds': 300, 'total': 0, 'failed': 0, 'medianLatencyMs': None, 'last60s': 0})

    def test_the_last_minute_is_told_apart_by_the_docker_timestamp(self):
        log = '\n'.join([stamped(done_line(), ago=30), stamped(done_line(), ago=59), stamped(done_line(), ago=61), stamped(done_line(), ago=280)])
        result = stats(log)
        self.assertEqual((result['total'], result['last60s']), (4, 2))

    def test_lines_without_a_timestamp_make_the_last_minute_unknown_not_zero(self):
        result = stats(done_line())
        self.assertEqual(result['total'], 1)
        self.assertIsNone(result['last60s'])

    def test_failure_is_none(self):
        def run(*args, **kwargs):
            return completed(returncode=1)
        self.assertIsNone(metrics.safe(metrics.request_stats)('sub2api', run=run))

    def test_only_the_end_of_the_log_is_read_with_docker_timestamps(self):
        # 只带 --since 会从头扫整份日志（线上 700 多 MB 要 17 秒），必须带 --tail
        seen = []

        def run(args, **kwargs):
            seen.append(args)
            return completed(stdout='')
        metrics.request_stats('sub2api', run=run)
        self.assertEqual(seen, [['docker', 'logs', '--timestamps', '--tail', '2000', '--since', '300s', 'sub2api']])

    def test_a_busy_window_reads_more_and_a_window_too_big_for_every_step_is_unknown(self):
        seen = []

        def run(args, **kwargs):
            seen.append(args[4])
            return completed(stdout='\n'.join([stamped(done_line())] * 3))
        # 第一次读 3 行就满了：再读 5 行，这次没满，3 个都数到
        self.assertEqual(metrics.request_stats('sub2api', run=run, now=lambda: NOW, tails=(3, 5))['total'], 3)
        self.assertEqual(seen, ['3', '5'])
        # 每一步都读满了：数不全，宁可说取不到，也不给一个偏小的数
        self.assertIsNone(metrics.safe(metrics.request_stats)('sub2api', run=run, tails=(2, 3)))

    def test_lines_on_both_output_streams_are_counted(self):
        def run(*args, **kwargs):
            return completed(stdout=stamped(done_line('/v1/messages')), stderr=stamped(done_line('/v1/chat/completions')) + '\n')
        self.assertEqual(metrics.request_stats('sub2api', run=run, now=lambda: NOW)['total'], 2)


ROUTE_TABLE = '\n'.join([
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'eth0\t00000000\t0102000A\t0003\t0\t0\t100\t00000000\t0\t0\t0',
    'eth1\t00000000\t0103000A\t0003\t0\t0\t50\t00000000\t0\t0\t0',
    'eth2\t00000000\t0104000A\t0000\t0\t0\t0\t00000000\t0\t0\t0',   # 没启用的路由不算
    'wg0\t0000000A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0',     # 不是默认路由
    '',
])


def fake_sysfs(test, iface='eth0', rx=123456789, tx=987654321):
    base = tempfile.mkdtemp()
    test.addCleanup(lambda: __import__('shutil').rmtree(base, ignore_errors=True))
    os.makedirs(os.path.join(base, iface, 'statistics'))
    for name, value in (('rx_bytes', rx), ('tx_bytes', tx)):
        with open(os.path.join(base, iface, 'statistics', name), 'w') as f:
            f.write('%d\n' % value)
    return base


class NetTests(unittest.TestCase):
    def test_the_default_route_with_the_lowest_metric_wins(self):
        self.assertEqual(metrics.default_route_iface(write_file(self, ROUTE_TABLE)), 'eth1')

    def test_no_default_route_is_an_error_not_a_guess(self):
        only_local = '\n'.join(ROUTE_TABLE.splitlines()[:1] + ROUTE_TABLE.splitlines()[4:5]) + '\n'
        self.assertIsNone(metrics.safe(metrics.default_route_iface)(write_file(self, only_local)))

    def test_boot_time_comes_from_btime(self):
        self.assertEqual(metrics.read_boot_time(write_file(self, 'cpu  1 2 3 4\nbtime 1700001234\nprocesses 9\n')), 1700001234)
        self.assertIsNone(metrics.safe(metrics.read_boot_time)(write_file(self, 'cpu  1 2 3 4\n')))

    def test_counters_of_the_internet_facing_card_and_the_boot_time(self):
        base = fake_sysfs(self, 'eth1')
        result = metrics.read_net(base=base, route_path=write_file(self, ROUTE_TABLE), stat_path=write_file(self, 'btime 1700000000\n'))
        self.assertEqual(result, {'iface': 'eth1', 'rxBytes': 123456789, 'txBytes': 987654321, 'bootAt': 1700000000})

    def test_a_configured_card_is_used_as_is(self):
        base = fake_sysfs(self, 'ens3', rx=5, tx=6)
        result = metrics.read_net('ens3', base=base, route_path='/nonexistent', stat_path=write_file(self, 'btime 1\n'))
        self.assertEqual((result['iface'], result['rxBytes'], result['txBytes']), ('ens3', 5, 6))

    def test_a_card_name_that_could_point_elsewhere_is_refused(self):
        for bad in ('../../etc', 'eth0/../x', '', 'a' * 16):
            self.assertIsNone(metrics.safe(metrics.read_iface_counters)(bad), bad)


class BackupListTests(unittest.TestCase):
    def make_dir(self, files):
        base = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__('shutil').rmtree(base, ignore_errors=True))
        for name, size, mtime in files:
            path = os.path.join(base, name)
            with open(path, 'wb') as f:
                f.write(b'x' * size)
            os.utime(path, (mtime, mtime))
        return base

    def test_the_newest_backup_and_the_count_hidden_and_other_files_left_out(self):
        base = self.make_dir([
            ('sub2api-20261010T203000Z.dump', 100, 1791000000),
            ('sub2api-20261011T203000Z.dump', 250, 1791086400),
            ('.sub2api-20261012T203000Z.dump.partial', 999, 1791172800),   # 还在写的临时文件
            ('.lock', 0, 1791172800),
            ('notes.txt', 5, 1791172800),
        ])
        os.mkdir(os.path.join(base, 'old.dump'))  # 目录不算
        self.assertEqual(metrics.read_backups(base), {'count': 2, 'latestAt': 1791086400000, 'latestBytes': 250})

    def test_an_empty_directory_has_no_latest_backup(self):
        self.assertEqual(metrics.read_backups(self.make_dir([])), {'count': 0, 'latestAt': None, 'latestBytes': None})

    def test_a_pattern_narrows_the_files(self):
        base = self.make_dir([('a.dump', 1, 1000), ('b.sql.gz', 2, 2000)])
        self.assertEqual(metrics.read_backups(base, '*.sql.gz')['latestBytes'], 2)

    def test_a_missing_directory_is_unknown_not_empty(self):
        self.assertIsNone(metrics.safe(metrics.read_backups)('/nonexistent-backup-dir'))


class ProbeTcpTests(unittest.TestCase):
    def test_a_listening_port_is_up(self):
        with socket.socket() as server:
            server.bind(('127.0.0.1', 0))
            server.listen(1)
            port = server.getsockname()[1]
            result = metrics.probe_tcp('127.0.0.1', port, timeout=2)
        self.assertIs(result['ok'], True)
        self.assertIsNotNone(result['rttMs'])

    def test_a_refused_connection_means_the_peer_answered_so_the_link_is_up(self):
        # 本机一个没人监听的端口：对面回了 RST，说明包已经到了
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            port = s.getsockname()[1]
        result = metrics.probe_tcp('127.0.0.1', port, timeout=2)
        self.assertIs(result['ok'], True)

    def test_a_timeout_is_down(self):
        result = metrics.probe_tcp('192.0.2.2', 8898, connect=fake_connect(socket.timeout('timed out')))
        self.assertEqual(result, {'ok': False, 'rttMs': None})

    def test_no_route_to_host_is_down(self):
        result = metrics.probe_tcp('192.0.2.2', 8898, connect=fake_connect(OSError(errno.EHOSTUNREACH, 'No route to host')))
        self.assertEqual(result, {'ok': False, 'rttMs': None})

    def test_a_tunnel_address_this_machine_does_not_have_is_down(self):
        # 真实的绑定失败：203.0.113.250 是文档保留地址，本机没有，bind 会直接失败，不会发出任何包
        result = metrics.probe_tcp('127.0.0.1', 9, source_ip='203.0.113.250', timeout=2)
        self.assertIs(result['ok'], False)

    def test_a_name_that_does_not_resolve_is_unknown_not_down(self):
        self.assertIsNone(metrics.probe_tcp('no-such-host.example', 8898, connect=fake_connect(socket.gaierror('no such host'))))

    def test_the_source_address_is_passed_when_given(self):
        seen = {}

        def connect(address, timeout=None, source_address=None):
            seen['source'] = source_address
            raise ConnectionRefusedError()
        metrics.probe_tcp('192.0.2.2', 8898, source_ip='192.0.2.1', connect=connect)
        self.assertEqual(seen['source'], ('192.0.2.1', 0))


class ProbeTests(unittest.TestCase):
    def test_healthy_service_is_true(self):
        self.assertIs(metrics.probe_http('http://probe.invalid/health', opener=FakeOpener(lambda u, t: FakeResponse(200))), True)

    def test_refused_connection_is_false_not_none(self):
        def opener(url, timeout):
            raise urllib.error.URLError('refused')
        self.assertIs(metrics.probe_http('http://probe.invalid/health', opener=FakeOpener(opener)), False)

    def test_a_reply_that_is_not_http_is_false_not_an_exception(self):
        def opener(url, timeout):
            raise http.client.BadStatusLine('garbage')
        self.assertIs(metrics.probe_http('http://probe.invalid/health', opener=FakeOpener(opener)), False)


class NodeFactsTests(unittest.TestCase):
    def failing_sources(self):
        return {
            'memory': lambda: None,
            'disk': lambda path: None,
            'load': lambda: None,
            'containers': lambda expected: None,
            'probe': lambda url: False,
            'requests': lambda container: None,
            'net': lambda iface: None,
            'backup': lambda directory, pattern: None,
        }

    def test_unreadable_values_stay_none_and_a_down_service_is_false(self):
        settings = {'sub2api_health_url': 'http://probe.invalid/health', 'request_container': 'sub2api',
                    'expect_containers': ['sub2api']}
        node = metrics.node_facts(settings, FakeCpu(None), 1000, self.failing_sources())
        self.assertTrue(node['reachable'])
        for key in ('cpuPercent', 'memory', 'disk', 'loadAvg', 'containers', 'requests', 'requests60s', 'net'):
            self.assertIsNone(node[key], key)
        self.assertIs(node['sub2apiOk'], False)

    def test_without_a_health_url_or_container_nothing_is_measured(self):
        node = metrics.node_facts({}, FakeCpu(12.5), 1000, self.failing_sources())
        self.assertEqual(node['cpuPercent'], 12.5)
        self.assertIsNone(node['sub2apiOk'])
        self.assertIsNone(node['requests'])
        self.assertIsNone(node['requests60s'])

    def test_backups_are_only_looked_at_when_a_directory_is_configured(self):
        seen = []

        def backup(directory, pattern):
            seen.append((directory, pattern))
            return {'count': 1, 'latestAt': 5, 'latestBytes': 6}
        sources = dict(self.failing_sources(), backup=backup)
        node = metrics.node_facts({}, FakeCpu(1.0), 1000, sources)
        self.assertEqual((node['backupConfigured'], node['backup']), (False, None))
        node = metrics.node_facts({'backup_dir': '/var/backups/x'}, FakeCpu(1.0), 1000, sources)
        self.assertEqual((node['backupConfigured'], node['backup']['count']), (True, 1))
        metrics.node_facts({'backup_dir': '/b', 'backup_pattern': 'db-*.dump'}, FakeCpu(1.0), 1000, sources)
        self.assertEqual(seen, [('/var/backups/x', '*.dump'), ('/b', 'db-*.dump')])

    def test_the_network_card_setting_is_passed_and_empty_means_automatic(self):
        seen = []
        sources = dict(self.failing_sources(), net=lambda iface: seen.append(iface))
        metrics.node_facts({'net_iface': 'ens3'}, FakeCpu(1.0), 1000, sources)
        metrics.node_facts({'net_iface': ''}, FakeCpu(1.0), 1000, sources)
        self.assertEqual(seen, ['ens3', None])

    def test_the_old_one_minute_count_comes_from_the_five_minute_reading(self):
        sources = dict(self.failing_sources(), requests=lambda container: {
            'windowSeconds': 300, 'total': 9, 'failed': 1, 'medianLatencyMs': 1200, 'last60s': 2})
        node = metrics.node_facts({'request_container': 'sub2api'}, FakeCpu(1.0), 1000, sources)
        self.assertEqual(node['requests']['total'], 9)
        self.assertEqual(node['requests60s'], 2)


if __name__ == '__main__':
    unittest.main()
