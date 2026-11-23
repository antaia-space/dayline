import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexAdapter } from '../src/agents/codex.mjs';

// Exercise the documented CLI/stdio protocol without contacting a model or an account.
async function client(t, options = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), 'dayline-client-fixture-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const binary = path.join(folder, 'codex');
  await writeFile(path.join(folder, 'options'), JSON.stringify(options));
  const program = [
    '#!' + process.execPath,
    "const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');",
    "const root = __dirname, opt = JSON.parse(fs.readFileSync(path.join(root, 'options')));",
    "const log = x => fs.appendFileSync(path.join(root, 'calls'), JSON.stringify(x) + '\\n');",
    "const reply = x => process.stdout.write(JSON.stringify(x) + '\\n');",
    "if (process.argv[2] === 'app-server') {",
    "  readline.createInterface({input:process.stdin}).on('line', line => {",
    "    const q=JSON.parse(line); log(q.method); let result;",
    "    switch(q.method) {",
    "      case 'initialized': return;",
    "      case 'initialize': result={userAgent:'fixture'}; break;",
    "      case 'account/read': result={account:{type:opt.account || 'chatgpt', planType:'plus', email:'hidden@example.test'}}; break;",
    "      case 'model/list': result=q.params.cursor ? {data:[{model:'model-b',displayName:'Model B'},...(opt.pinned ? [{model:'gpt-6.2-sol',displayName:'GPT-6.2 Sol'}] : [])],nextCursor:null} : {data:[{model:'model-a',displayName:'Model A',isDefault:true},{model:'hidden',hidden:true}],nextCursor:'page-two'}; break;",
    "      case 'account/rateLimits/read': result={rateLimits:{primary:{usedPercent:12,windowDurationMins:300}}}; break;",
    "      case 'config/read': result={config:{cli_auth_credentials_store:'keyring'}}; break;",
    "      default: return reply({id:q.id,error:{code:-32601}});",
    "    } reply({id:q.id,result});",
    "  });",
    "} else if (process.argv[2] === 'exec') {",
    "  const args=process.argv.slice(2), readArg=key =>args[args.indexOf(key)+1];",
    "  const instructionsArg=args.find(a=>a.startsWith('model_instructions_file='));",
    "  const record={args,cwd:process.cwd(),schema:JSON.parse(fs.readFileSync(readArg('--output-schema'))),instructions:fs.readFileSync(JSON.parse(instructionsArg.split('=').slice(1).join('=')),'utf8'),input:fs.readFileSync(0,'utf8'),hasApiKey:Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY)};",
    "  fs.writeFileSync(path.join(root,'estimate'),JSON.stringify(record)); log('exec');",
    "  reply({type:'thread.started',thread_id:'thread'});",
    "  if(opt.notice) reply({type:'item.completed',item:{id:'item_0',type:'error',message:opt.notice}});",
    "  reply({type:'turn.started'});",
    "  if(opt.passive) for (const type of ['user_message','reasoning','context_compaction']) reply({type:'item.completed',item:{type}});",
    "  if(opt.tool) { reply({type:'item.started',item:{type:'command_execution'}}); setTimeout(()=>fs.writeFileSync(path.join(root,'continued-after-tool'),'1'),750); }",
    "  reply({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({minutes:35})}});",
    "  reply({type:'turn.completed',usage:{input_tokens:18,output_tokens:5,cached_input_tokens:7}});",
    "} else process.exit(3);",
  ].join('\n');
  await writeFile(binary, program, { mode: 0o700 });
  return { ...createCodexAdapter(() => binary), folder };
}

const schema = { type: 'object', properties: { minutes: { type: 'integer' } }, required: ['minutes'], additionalProperties: false };
const request = { model: 'model-b', instructions: 'Estimate minutes.', input: { task: 'Review the agenda' }, schema };

test('Codex discovery uses the official account, paged model catalog and reported limit', async t => {
  const adapter = await client(t);
  const result = await adapter.codexStatus();
  assert.equal(result.signedIn, true);
  assert.equal(result.defaultModel, 'model-a');
  assert.equal(result.plan, 'plus');
  assert.equal(result.quota, '12% used in 5h');
  assert.deepEqual(result.models, [{ id: 'model-a', label: 'Model A' }, { id: 'model-b', label: 'Model B' }]);
  assert.ok(!JSON.stringify(result).includes('hidden@example.test'));
  assert.ok(!(await readFile(path.join(adapter.folder, 'calls'), 'utf8')).includes('"exec"'));
});

test('Codex requires ChatGPT subscription sign-in and validates chosen models before inference', async t => {
  const keyed = await client(t, { account: 'apiKey' });
  assert.equal((await keyed.codexStatus()).signedIn, false);
  await assert.rejects(keyed.codexEstimate(request), /ChatGPT sign-in/);
  const calls = await readFile(path.join(keyed.folder, 'calls'), 'utf8');
  assert.ok(!calls.includes('"exec"') && !calls.includes('"model/list"'));
  const adapter = await client(t);
  await assert.rejects(adapter.codexEstimate({ ...request, model: 'unlisted' }), /model list/);
  assert.ok(!(await readFile(path.join(adapter.folder, 'calls'), 'utf8')).includes('"exec"'));
});

test('one isolated Codex turn receives the selected model, schema and task through stdin', async t => {
  const adapter = await client(t);
  const estimate = await adapter.codexEstimate(request);
  assert.deepEqual(estimate, { output: { minutes: 35 }, model: 'model-b', effort: 'low', usage: { inputTokens: 18, cachedInputTokens: 7, outputTokens: 5 } });
  const run = JSON.parse(await readFile(path.join(adapter.folder, 'estimate'), 'utf8'));
  assert.equal(run.hasApiKey, false);
  assert.deepEqual(JSON.parse(run.input), request.input);
  assert.deepEqual(run.schema, schema);
  assert.ok(run.instructions.includes(request.instructions));
  assert.ok(!JSON.stringify(run.args).includes(request.input.task));
  for (const flag of ['--ephemeral','--ignore-user-config','--ignore-rules','approval_policy="never"','forced_login_method="chatgpt"','cli_auth_credentials_store="keyring"','web_search="disabled"','mcp_servers={}', 'skills.include_instructions=false', 'skills.bundled.enabled=false', 'tools.experimental_request_user_input.enabled=false', 'tools.update_plan.enabled=false', 'model_reasoning_effort="low"']) {
    assert.ok(run.args.includes(flag), flag);
  }
  const features = run.args.find(arg => arg.startsWith('features={'));
  for (const name of ['hooks','shell_tool','code_mode','computer_use','plugins','apps','multi_agent','goals','default_mode_request_user_input']) assert.ok(features.includes(name + '=false'));
  assert.ok(run.args.includes('permissions.dayline={filesystem={":workspace_roots"="read"},network={enabled=false}}'));
  assert.equal(run.args[run.args.indexOf('--model') + 1], 'model-b');
  await assert.rejects(access(run.cwd), { code: 'ENOENT' });
});

test('a Codex run reporting any tool activity cannot become a task estimate', async t => {
  const adapter = await client(t, { tool: true });
  await assert.rejects(adapter.codexEstimate(request), error => error.message.includes('tool during a text-only estimate (command_execution)') &&
    error.model === 'model-b' && error.effort === 'low');
  await assert.rejects(access(path.join(adapter.folder, 'continued-after-tool')), { code: 'ENOENT' });
});

test('accepts passive startup notices emitted by the actual Codex CLI and pins GPT-6.2 Sol when no model was chosen', async t => {
  for (const notice of [
    'Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.\n  session-flags: `include_skill_instructions` is ignored.',
    'Under-development features enabled: skip_host_skill_discovery. Under-development features are incomplete.',
    'Model metadata for `gpt-6.2-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
  ]) {
    const adapter = await client(t, { pinned: true, notice, passive: true });
    const result = await adapter.codexEstimate({ ...request, model: '' });
    assert.equal(result.model, 'gpt-6.2-sol');
    assert.equal(result.effort, 'low');
    assert.equal(result.output.minutes, 35);
    const { args } = JSON.parse(await readFile(path.join(adapter.folder, 'estimate'), 'utf8'));
    assert.equal(args[args.indexOf('--model') + 1], 'gpt-6.2-sol');
    assert.ok(args.includes('model_reasoning_effort="low"'));
    assert.ok(!args.includes('include_skill_instructions=false'));
  }
  const missing = await client(t);
  await assert.rejects(missing.codexEstimate({ ...request, model: '' }), /model list/);
  assert.ok(!(await readFile(path.join(missing.folder, 'calls'), 'utf8')).includes('"exec"'));
});

test('an unfamiliar diagnostic aborts without exposing raw client details', async t => {
  const adapter = await client(t, { notice: 'Unrecognized security setting for private@example.test.' });
  await assert.rejects(adapter.codexEstimate(request), error => error.message.includes('diagnostic (error)') &&
    !error.message.includes('@') && error.model === 'model-b');
});
