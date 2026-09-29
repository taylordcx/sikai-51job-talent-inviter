"""Consultant-owned search values; no browser, contact, or account-state side effects."""
import copy
import hashlib
import json


FIELDS = {'keywords', 'desired_locations', 'current_locations', 'experience', 'education', 'active_within'}


class SearchError(ValueError):
    pass


def empty_request():
    return {'job_key': None, 'filters': {}, 'clear': [], 'keep': []}


def fingerprint(state):
    return hashlib.sha256(json.dumps(state, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def check_state(state):
    if not isinstance(state, dict) or state.get('page') != 'talent-search' or state.get('blocked') is not False or state.get('loading') is True:
        raise SearchError('人才搜索页未确认就绪或存在遮挡，请先检查页面')
    if not isinstance(state.get('filters'), dict) or not isinstance(state.get('jobs'), list):
        raise SearchError('无法完整读取岗位或搜索条件')
    jobs = state['jobs']
    if any(not isinstance(j, dict) or not isinstance(j.get('key'), str) or not j['key'] or
           not isinstance(j.get('name'), str) or not j['name'] or j['name'] == '不限职位' for j in jobs):
        raise SearchError('岗位选项无有效标识或名称')
    keys = [j['key'] for j in jobs]
    if len(keys) != len(set(keys)):
        raise SearchError('岗位标识重复，不能可靠选择')


def validate_values(values):
    if not isinstance(values, dict) or set(values) - FIELDS:
        raise SearchError('搜索字段不支持；仅允许关键词、地点、学历、工作年限和活跃时间')
    for field, value in values.items():
        if field.endswith('_locations'):
            if (not isinstance(value, list) or not value or
                any(not isinstance(v, str) or not v.strip() or v != v.strip() for v in value) or
                len(set(value)) != len(value)):
                raise SearchError(field + ' 必须是非空、不重复的地点列表')
        elif not isinstance(value, str) or not value.strip() or value != value.strip():
            raise SearchError(field + ' 必须是非空文本；清除条件请使用 clear')


def prepare(request, state):
    check_state(state)
    if not isinstance(request, dict) or set(request) - {'job_key', 'filters', 'clear', 'keep'}:
        raise SearchError('顾问输入格式不正确')
    key = request.get('job_key')
    matches = [j for j in state['jobs'] if j['key'] == key]
    if len(matches) != 1:
        raise SearchError('请从页面读取的岗位中选择明确的 job_key，不自动选第一项或相似岗位')
    values = copy.deepcopy(request.get('filters', {}))
    validate_values(values)
    clear, keep = request.get('clear', []), request.get('keep', [])
    for entries in (clear, keep):
        if (not isinstance(entries, list) or any(not isinstance(e, str) for e in entries) or
                len(set(entries)) != len(entries) or set(entries) - FIELDS):
            raise SearchError('clear 和 keep 必须是有效、不重复的字段名列表')
    clear, keep = set(clear), set(keep)
    if 'desired_locations' not in values and 'desired_locations' not in clear | keep:
        values['desired_locations'] = ['义乌', '杭州']
    if clear & keep or (clear | keep) & set(values):
        raise SearchError('同一个条件不能同时填写、清除或保留')
    active = state['filters']
    unresolved = set(active) - set(values) - clear - keep
    if unresolved:
        raise SearchError('页面存在未处理的旧条件：' + ', '.join(sorted(unresolved)))
    if keep - set(active):
        raise SearchError('要求保留的条件未在页面中读到')
    for field in keep:
        values[field] = copy.deepcopy(active[field])
    validate_values(values)
    for field in values:
        if field.endswith('_locations'):
            values[field] = sorted(values[field])
    return {'version': 1, 'before': fingerprint(state), 'job': copy.deepcopy(matches[0]),
            'filters': values, 'clear': sorted(clear), 'input': copy.deepcopy(request),
            'jobs_complete': state.get('jobs_complete') is True}


def verify(state, plan):
    check_state(state)
    if state.get('selected_job') != plan['job']['key']:
        raise SearchError('关联岗位未生效，已停止')
    if state['filters'] != plan['filters']:
        differing = sorted(k for k in set(state['filters']) | set(plan['filters'])
                           if state['filters'].get(k) != plan['filters'].get(k))
        raise SearchError('搜索条件读回不一致，已停止：' + ', '.join(differing))


def execute(plan, browser, submit=False):
    def read_checked():
        current = browser.read()
        check_state(current)
        return current

    state = read_checked()
    if fingerprint(state) != plan['before']:
        raise SearchError('页面条件或岗位清单已变化，请重新核对计划')
    expected = prepare(plan['input'], state)
    if expected != plan:
        raise SearchError('计划内容与顾问输入不一致')
    if state.get('selected_job') != plan['job']['key']:
        browser.select_job(plan['job']['key'])
        if read_checked().get('selected_job') != plan['job']['key']:
            raise SearchError('关联岗位未生效，已停止')
    if 'keywords' in plan['filters'] and read_checked()['filters'].get('keywords') != plan['filters']['keywords']:
        browser.set_filter('keywords', plan['filters']['keywords'])
        if read_checked()['filters'].get('keywords') != plan['filters']['keywords']:
            raise SearchError('关键词未生效，已停止')
    # Read after job selection: some versions reset or infer search filters on selection.
    for field in plan['clear']:
        if field in read_checked()['filters']:
            browser.set_filter(field, None)
            if field in read_checked()['filters']:
                raise SearchError('清除未生效：' + field)
    # Keyword entry enables other controls on the verified enterprise page.
    ordered = sorted(plan['filters'], key=lambda k: (k == 'desired_locations', k != 'keywords', k))
    for field in ordered:
        value = plan['filters'][field]
        if read_checked()['filters'].get(field) != value:
            browser.set_filter(field, copy.deepcopy(value))
            if read_checked()['filters'].get(field) != value:
                raise SearchError('条件未生效：' + field)
    verify(read_checked(), plan)
    if submit:
        outcome = browser.search()
        verify(read_checked(), plan)
    status = 'prepared'
    if submit:
        status = 'search_submitted' if isinstance(outcome, dict) and outcome.get('confirmed') is False else 'searched'
    return {'status': status, 'job': plan['job'],
            'filters': plan['filters'], 'contacted': 0, 'jobs_complete': plan['jobs_complete']}
