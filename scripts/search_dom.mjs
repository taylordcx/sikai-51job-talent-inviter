// Selectors below were read from the user's enterprise search page on 2026-09-22.
// No candidate-list selectors and no network/API scraping.
export function pageOperation(operation, args = {}) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = e => e && e.getBoundingClientRect().width > 0 &&
    e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden';
  const all = (s, root = document) => Array.from(root.querySelectorAll(s));
  const one = s => {const es=all(s).filter(visible);if(es.length!==1)throw Error('控件不唯一或不可见：'+s);return es[0];};
  const pos = e => {
    if (!visible(e) || e.disabled) throw Error('控件不可用');
    e.scrollIntoView({block:'nearest',inline:'nearest'});
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
    const top=document.elementFromPoint(x,y);
    if (!top || !(e===top || e.contains(top))) throw Error('控件被遮挡，已停止');
    return {x,y};
  };
  const getDialog = () => {
    const ds=all('.el-dialog').filter(e=>visible(e)&&norm(e.querySelector('.eh_cascader_dialog_title')?.textContent)==='选择城市');
    if(ds.length!==1)throw Error('无法确认期望工作地弹窗');return ds[0];
  };
  const tagText = e => {const c=e.cloneNode(true);c.querySelectorAll('.el-tag__close').forEach(n=>n.remove());return norm(c.textContent);};
  const jobData = e => {
    const name=norm(e.querySelector('.job-item-name')?.textContent);
    const tags=all('.job-item-tags span',e).map(s=>norm(s.textContent));
    if(!name)throw Error('岗位名称缺失');
    return {key:'ui:'+encodeURIComponent(JSON.stringify([name,tags])), name, location:tags[0]||'', details:tags};
  };
  const jobs = () => all('.talent_search_select_job_dropdown .job-item');
  const fields = () => all('.search_params .base-select-button').map(button=>{
    const ref=button.closest('[aria-describedby]');
    const panel=ref&&document.getElementById(ref.getAttribute('aria-describedby'));
    const options=panel?all('.option-item-label',panel).map(e=>norm(e.textContent)):[];
    const label=norm(button.querySelector('.base-select-label')?.textContent);
    let field;
    if(options.includes('无经验')&&options.includes('10年及以上'))field='experience';
    else if(options.includes('大专及以上')&&options.includes('本科及以上'))field='education';
    return {button,panel,options,label,field};
  });
  const field = name => {const fs=fields().filter(f=>f.field===name);if(fs.length!==1)throw Error('未适配或无法识别的条件：'+name);return fs[0];};
  const defaults = new Set(['工作年限','年龄','学历要求','学校性质','居住地','期望行业','期望职能','期望月薪','从事行业','从事职能','不限']);
  if(!['ehire.51job.com','mall.51job.com'].includes(location.hostname) || !location.pathname.endsWith('/talent/search'))
    throw Error('当前不是已核实的人才搜索页');
  if(operation==='readiness')return {loading:all('.el-loading-mask').some(visible),blocked:all('.el-dialog,.el-message-box,.v-modal').some(visible)};
  if(operation==='has-jobs')return jobs().some(visible);
  if(operation==='jobs-menu-open')return all('.talent_search_select_job_dropdown').some(visible);
  if(operation==='jobs-open')return pos(one('.code_filter .cur_selected_job_tag_content'));
  if(operation==='dismiss-jobs')return pos(all('.search-row-label').filter(visible)[0]);
  if(operation==='state') {
    one('.code_filter');one('.search_params');
    const entries=jobs(), data=entries.map(jobData);
    if(!data.length)throw Error('尚未读取岗位下拉');
    const active=entries.filter(e=>e.classList.contains('active'));
    const selected=active.length===1?jobData(active[0]).key:null;
    const filters={};
    const keyword=document.querySelector('.talent_search_keywords_input input');
    if(!keyword)throw Error('关键词框缺失');
    if(keyword.value.trim())filters.keywords=keyword.value.trim();
    const city=norm(document.querySelector('.outer_search_address')?.getAttribute('title'));
    if(city&&city!=='期望工作地'&&city!=='全国')filters.desired_locations=city.split('+').map(norm).sort();
    const available={};
    for(const f of fields()){
      if(f.field)available[f.field]=f.options;
      if(f.label&&!defaults.has(f.label))filters[f.field||'unmapped:'+f.label]=f.label;
    }
    for(const e of all('.search_params .el-select input'))
      if(e.value.trim())filters['unmapped:'+e.placeholder]=e.value.trim();
    // A loading mask or dialog stops the workflow; job dropdown is expected here.
    const blocked=all('.el-dialog,.el-message-box,.v-modal').some(visible);
    const loading=all('.el-loading-mask').some(visible);
    return {page:'talent-search',blocked,loading,jobs_complete:false,jobs:data,selected_job:selected,filters,available};
  }
  if(operation==='job'){
    const es=jobs().filter(e=>jobData(e).key===args.key);
    if(es.length!==1)throw Error('岗位不存在或重复，不能按名字猜测');return pos(es[0]);
  }
  if(operation==='keyword-focus'){
    const e=one('.talent_search_keywords_input input');pos(e);e.focus();e.select();return true;
  }
  if(operation==='field-open')return pos(field(args.field).button);
  if(operation==='field-option'){
    const f=field(args.field),wanted=args.value===null?'不限':args.value;
    const es=all('.option-item',f.panel).filter(e=>visible(e)&&norm(e.textContent)===wanted);
    if(es.length!==1)throw Error('该条件值不在当前可选项中：'+wanted);return pos(es[0]);
  }
  if(operation==='city-open')return pos(one('.code_filter .outer_search_address'));
  if(operation==='city-values')return all('.dialog_footer_content_tag .el-tag',getDialog()).map(tagText).sort();
  if(operation==='city-remove'){
    const es=all('.dialog_footer_content_tag .el-tag',getDialog()).filter(e=>tagText(e)===args.value);
    if(es.length!==1)throw Error('找不到待移除地点');return pos(es[0].querySelector('.el-tag__close'));
  }
  if(operation==='city-input'){
    const es=all('.el-dialog__header input',getDialog()).filter(visible);
    if(es.length!==1)throw Error('城市搜索框不唯一');pos(es[0]);es[0].focus();es[0].select();return true;
  }
  if(operation==='city-option'){
    const dialog=getDialog();
    let es=all('.el-autocomplete-suggestion li').filter(e=>visible(e)&&norm(e.textContent)===args.value);
    if(!es.length)es=all('.cascader_panel_item.leaf',dialog).filter(e=>visible(e)&&norm(e.querySelector('.cascader_item_label')?.textContent)===args.value);
    if(es.length!==1)throw Error('未找到唯一的城市选项：'+args.value);return pos(es[0]);
  }
  if(operation==='city-confirm')return pos(getDialog().querySelector('.confirm_button'));
  if(operation==='city-close')return pos(getDialog().querySelector('.el-dialog__headerbtn'));
  if(operation==='search'){
    const e=one('.code_filter .search_button');
    if(e.disabled || !document.querySelector('.talent_search_keywords_input input')?.value.trim())throw Error('搜索按钮未启用或关键词为空');return pos(e);
  }
  throw Error('未知页面操作');
}
