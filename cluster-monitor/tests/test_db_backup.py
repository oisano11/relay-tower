"""数据库备份脚本 backup/db-backup.sh 的测试：用一个假的 docker 命令，不连任何数据库。"""
import json
import os
import shutil
import stat
import subprocess
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'backup', 'db-backup.sh')
PASSWORD = 'fake-db-password-for-tests'

# 假的 docker：inspect 给出容器的环境变量；run 按参数假装执行 pg_dump / pg_restore。
# 每次调用的参数和「PGPASSWORD 有没有传进来」都记到 FAKE_DOCKER_LOG。
FAKE_DOCKER = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['FAKE_DOCKER_LOG'], 'a') as log:
    log.write(json.dumps({'args': args, 'pgpassword': os.environ.get('PGPASSWORD')}) + '\n')
if args[0] == 'inspect':
    sys.stdout.write(os.environ.get('FAKE_ENV', ''))
    sys.exit(0)
if args[0] != 'run':
    sys.exit(2)
mount = args[args.index('-v') + 1].split(':')
host_dir = mount[0]
mode = os.environ.get('FAKE_MODE', 'ok')
if 'pg_dump' in args:
    target = args[args.index('-f') + 1]
    path = os.path.join(host_dir, os.path.basename(target))
    if mode == 'empty':
        open(path, 'w').close()
        sys.exit(0)
    with open(path, 'w') as f:
        f.write('PGDMP' if mode != 'corrupt' else 'garbage')
    sys.exit(1 if mode == 'dump-fails' else 0)
if 'pg_restore' in args:
    path = os.path.join(host_dir, os.path.basename(args[-1]))
    with open(path) as f:
        sys.exit(0 if f.read().startswith('PGDMP') else 1)
sys.exit(2)
'''

CONTAINER_ENV = '\n'.join([
    'TZ=Asia/Shanghai',
    'DATABASE_HOST=192.0.2.1',
    'DATABASE_PORT=5432',
    'DATABASE_USER=sub2api',
    'DATABASE_DBNAME=sub2api',
    'DATABASE_PASSWORD=' + PASSWORD,
    '',
])


class BackupScriptTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.bin = os.path.join(self.root, 'bin')
        os.mkdir(self.bin)
        docker = os.path.join(self.bin, 'docker')
        with open(docker, 'w') as f:
            f.write(FAKE_DOCKER)
        os.chmod(docker, 0o755)
        self.dir = os.path.join(self.root, 'backups')
        self.log = os.path.join(self.root, 'docker.log')

    def run_script(self, mode='ok', env_text=CONTAINER_ENV, **extra):
        env = dict(os.environ, PATH=self.bin + os.pathsep + os.environ.get('PATH', ''), BACKUP_DIR=self.dir,
                   FAKE_DOCKER_LOG=self.log, FAKE_MODE=mode, FAKE_ENV=env_text, MIN_FREE_MB='1', KEEP='3')
        env.pop('PGPASSWORD', None)
        env.update(extra)
        return subprocess.run(['sh', SCRIPT], env=env, capture_output=True, text=True, timeout=30)

    def calls(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as f:
            return [json.loads(line) for line in f]

    def dumps(self):
        return sorted(n for n in os.listdir(self.dir) if n.endswith('.dump') and not n.startswith('.'))

    def test_a_good_backup_is_kept_private_and_the_password_never_appears_on_a_command_line(self):
        done = self.run_script()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        names = self.dumps()
        self.assertEqual(len(names), 1)
        self.assertRegex(names[0], r'^sub2api-\d{8}T\d{6}Z\.dump$')
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.dir, names[0])).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(self.dir).st_mode), 0o700)
        self.assertEqual([n for n in os.listdir(self.dir) if 'partial' in n], [], 'no half-written file is left')
        calls = self.calls()
        dump = next(c for c in calls if 'pg_dump' in c['args'])
        self.assertEqual(dump['pgpassword'], PASSWORD, 'the password reaches docker through the environment')
        for call in calls:
            self.assertNotIn(PASSWORD, ' '.join(call['args']))
        args = dump['args']
        self.assertIn('-e', args)
        self.assertEqual(args[args.index('-e') + 1], 'PGPASSWORD', 'only the name is passed, never the value')
        self.assertIn('--exclude-table-data=ops_system_logs', args)
        self.assertEqual(args[args.index('-h') + 1], '192.0.2.1')
        self.assertIn('umask 077', ' '.join(args))
        self.assertIn('完成', done.stdout)

    def test_only_the_newest_copies_are_kept_counted_by_copies_not_days(self):
        os.makedirs(self.dir)
        old = int(time.time()) - 30 * 86400
        for i in range(4):
            path = os.path.join(self.dir, 'sub2api-2026090%dT203000Z.dump' % (i + 1))
            with open(path, 'w') as f:
                f.write('PGDMP')
            os.utime(path, (old + i * 86400, old + i * 86400))
        done = self.run_script(KEEP='3')
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        names = self.dumps()
        self.assertEqual(len(names), 3)
        self.assertIn('sub2api-20260904T203000Z.dump', names)
        self.assertIn('sub2api-20260903T203000Z.dump', names)
        self.assertNotIn('sub2api-20260901T203000Z.dump', names)

    def test_a_failed_dump_leaves_the_old_backups_alone_and_no_partial_file(self):
        os.makedirs(self.dir)
        keep = os.path.join(self.dir, 'sub2api-20260901T203000Z.dump')
        with open(keep, 'w') as f:
            f.write('PGDMP')
        for mode in ('dump-fails', 'corrupt', 'empty'):
            done = self.run_script(mode=mode, KEEP='1')
            self.assertNotEqual(done.returncode, 0, mode)
            self.assertIn('失败', done.stdout, mode)
            self.assertEqual(self.dumps(), ['sub2api-20260901T203000Z.dump'], mode)
            self.assertEqual([n for n in os.listdir(self.dir) if 'partial' in n], [], mode)

    def test_without_the_database_settings_nothing_is_run(self):
        done = self.run_script(env_text='TZ=UTC\n')
        self.assertNotEqual(done.returncode, 0)
        self.assertIn('读不到数据库', done.stdout)
        self.assertFalse(any(c['args'][0] == 'run' for c in self.calls()))

    def test_not_enough_disk_space_stops_before_dumping(self):
        done = self.run_script(MIN_FREE_MB='999999999')
        self.assertNotEqual(done.returncode, 0)
        self.assertIn('硬盘只剩', done.stdout)
        self.assertEqual(self.calls(), [])

    def test_a_bad_keep_value_is_refused_and_an_empty_one_means_the_default(self):
        for keep in ('0', 'x', '-1'):
            done = self.run_script(KEEP=keep)
            self.assertNotEqual(done.returncode, 0, keep)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.run_script(KEEP='').returncode, 0)


if __name__ == '__main__':
    unittest.main()
