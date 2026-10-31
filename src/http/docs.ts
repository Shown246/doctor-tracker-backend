import { Router } from 'express';
import {
  requireAuthentication,
  requireActiveAccount,
  allowRoles,
} from '../modules/auth/access.js';
import { createOpenApiDocument } from './openapi.js';

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Doctor Tracker API</title><link rel="stylesheet" href="/api/v1/docs/style.css"></head><body><main><h1>Doctor Tracker API</h1><p>Admin API explorer. Requests use your current session and can change stored data. Bootstrap or log in with a cookie-aware API client before opening this page.</p><p><a href="/api/v1/docs/openapi.json">Download OpenAPI 3.1 contract</a></p><label>Operation<select id="operation"></select></label><p id="description"></p><form id="request"><label>Path parameters (JSON object)<textarea id="path">{}</textarea></label><label>Query parameters (JSON object)<textarea id="query">{}</textarea></label><label>Request body (JSON; leave blank for no body)<textarea id="body"></textarea></label><button type="submit">Send request</button></form><p id="status" role="status"></p><pre id="response"></pre><details><summary>Operation contract</summary><pre id="schema"></pre></details></main><script src="/api/v1/docs/app.js" defer></script></body></html>`;
const css = `body{font:16px system-ui,sans-serif;background:#f8fafc;color:#0f172a;margin:0}main{max-width:960px;margin:2rem auto;padding:0 1rem}label{display:block;margin:1rem 0}select,textarea,button{display:block;box-sizing:border-box;width:100%;font:inherit;padding:.6rem;margin-top:.4rem}textarea{min-height:5rem;font-family:monospace}button{background:#0f766e;color:white;border:0;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#e2e8f0;padding:1rem}a{color:#0f766e}`;
const js = `const el=id=>document.getElementById(id);let operations=[];
async function initialize(){const result=await fetch('/api/v1/docs/openapi.json',{credentials:'same-origin'});if(!result.ok)throw Error('Admin session required');const spec=await result.json();for(const [path,item] of Object.entries(spec.paths)){for(const method of ['get','post','put','patch','delete']){if(item[method]){const operation=item[method];operations.push({path,method,operation,base:operation.servers?.[0]?.url??spec.servers[0].url});const option=document.createElement('option');option.value=String(operations.length-1);option.textContent=method.toUpperCase()+' '+path+' — '+operation.summary;el('operation').append(option);}}}show();}
function show(){const selected=operations[Number(el('operation').value)];el('description').textContent=selected.operation.description??'';el('schema').textContent=JSON.stringify(selected.operation,null,2);el('path').value=JSON.stringify(Object.fromEntries((selected.operation.parameters??[]).filter(p=>p.in==='path').map(p=>[p.name,''])),null,2);el('query').value='{}';el('body').value='';}
el('operation').addEventListener('change',show);
el('request').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{const selected=operations[Number(el('operation').value)];const params=JSON.parse(el('path').value);const path=selected.path.replace(/\\{(\\w+)\\}/g,(_,key)=>{if(!params[key])throw Error('Missing path parameter '+key);return encodeURIComponent(params[key]);});const url=new URL(selected.base.replace(/\\/$/,'')+path,location.origin);for(const [key,value] of Object.entries(JSON.parse(el('query').value)))url.searchParams.set(key,String(value));const headers={};if(selected.method!=='get'){const csrf=await fetch('/api/v1/auth/csrf',{credentials:'same-origin'});if(!csrf.ok)throw Error('CSRF bootstrap failed');headers['X-CSRF-Token']=(await csrf.json()).data.csrfToken;}const body=el('body').value.trim();if(body){JSON.parse(body);headers['Content-Type']='application/json';}const response=await fetch(url,{method:selected.method.toUpperCase(),credentials:'same-origin',headers,...(body?{body}: {})});el('status').textContent=response.status+' '+response.statusText;const text=await response.text();try{el('response').textContent=JSON.stringify(JSON.parse(text),null,2);}catch{el('response').textContent=text;}}catch(error){el('status').textContent=error.message;}finally{button.disabled=false;}});initialize().catch(error=>{el('status').textContent=error.message;});`;

export function docsRoutes() {
  const router = Router();
  router.use(requireAuthentication, requireActiveAccount, allowRoles('admin'));
  router.get('/', (_request, response) => {
    response.type('html').send(html);
  });
  router.get('/app.js', (_request, response) => {
    response.type('js').send(js);
  });
  router.get('/style.css', (_request, response) => {
    response.type('css').send(css);
  });
  router.get('/openapi.json', (_request, response) => {
    response.json(createOpenApiDocument());
  });
  return router;
}
