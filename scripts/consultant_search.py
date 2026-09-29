#!/usr/bin/env python3
"""Offline consultant-input validation. Does not search or contact anyone."""
import argparse
import json
import sys
from pathlib import Path

from search_flow import SearchError, empty_request, prepare, verify, execute


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def main():
    parser = argparse.ArgumentParser(description='顾问条件输入与人才搜索（不联系候选人）')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('template', help='生成无默认条件的输入模板')
    start = commands.add_parser('start-browser', help='打开可见招聘浏览器，不搜索或联系候选人')
    start.add_argument('--port', type=int, default=9222)
    plan = commands.add_parser('plan', help='用顾问输入和页面真实状态生成搜索计划')
    plan.add_argument('--request', required=True)
    plan.add_argument('--state', required=True)
    check = commands.add_parser('verify', help='核对填写后的页面条件，不表示已执行搜索')
    check.add_argument('--plan', required=True)
    check.add_argument('--state', required=True)
    for name in ('jobs', 'prepare-browser', 'search-browser'):
        live = commands.add_parser(name)
        live.add_argument('--port', type=int, default=9222)
        live.add_argument('--target')
        if name != 'jobs':
            live.add_argument('--request', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'start-browser':
            import shutil
            import subprocess
            node = shutil.which('node')
            if not node:
                raise SearchError('未找到Node.js；启动浏览器需要Node.js 22或以上版本')
            return subprocess.run([node, str(Path(__file__).with_name('start_browser.mjs')),
                                   '--port', str(args.port)], check=False).returncode
        elif args.command == 'template':
            result = empty_request()
        elif args.command == 'plan':
            result = prepare(read_json(args.request), read_json(args.state))
        elif args.command == 'verify':
            plan = read_json(args.plan)
            verify(read_json(args.state), plan)
            result = {'status': 'conditions_verified', 'contacted': 0}
        else:
            from browser_adapter import BrowserAdapter, preflight
            browser = BrowserAdapter(args.port, args.target)
            try:
                state = browser.read()
                if args.command == 'jobs':
                    result = state
                else:
                    plan = prepare(read_json(args.request), state)
                    preflight(plan, state)
                    result = execute(plan, browser, submit=args.command == 'search-browser')
            finally:
                browser.close()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (SearchError, OSError, ValueError, KeyError, TypeError) as e:
        print(json.dumps({'status': 'stopped', 'error': str(e)}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    sys.exit(main())
