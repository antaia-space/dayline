const agents = {
  local: { label:"Local on this Mac" },
  codex: { label:"OpenAI via Codex", service:"OpenAI", client:"Codex", install:"https://developers.openai.com/codex/cli/" },
  gemini: { label:"Google Gemini", service:"Google", client:"Antigravity CLI", install:"https://antigravity.google/docs/getting-started?tab=cli" },
  claude: { label:"Anthropic via Claude Code", service:"Anthropic", client:"Claude Code", install:"https://code.claude.com/" }
};
const id = (value) => document.getElementById(value);
const codexDefault = "gpt-6.2-sol";
const chosenModelId = (provider,value) => value.trim() || (provider === "codex" ? codexDefault : "");
const shown = (target,value) => {
  target.textContent = value || "";
  target.hidden = !value;
};
const agentLabel = (provider) => agents[provider]?.label || provider || "Unknown agent";

export function estimateSource(run) {
  if (!run || !run.provider) return "";
  const effort = run.provider === "codex" && run.effort ? run.effort + " reasoning effort" : "";
  if (run.outcome === "pending") {
    const requested = run.model ? "requested " + run.model : "";
    return ["Awaiting estimate",agentLabel(run.provider),requested,effort].filter(Boolean).join(" · ");
  }
  const selected = [agentLabel(run.provider),run.model,effort].filter(Boolean).join(" · ");
  if (run.outcome === "fallback") return run.provider === "local" ? "Local rules" : "Local rules · " + selected + " fallback";
  return selected;
}

function paintUsage(run) {
  if (!run) {
    id("agent-run").textContent = "Usage appears after the first estimate.";
    shown(id("agent-run-usage"),"");
    shown(id("agent-run-notice"),"");
    return;
  }
  const when = run.at ? new Date(run.at) : null;
  const time = Number.isFinite(when?.getTime()) ? when.toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"}) : "";
  id("agent-run").textContent = [estimateSource(run),time].filter(Boolean).join(" · ");
  const counts = [
    ["Input",run.inputTokens],["Cached input",run.cachedInputTokens],["Output",run.outputTokens]
  ].filter(([,count]) => Number.isFinite(count) && count >= 0)
   .map(([label,count]) => label + " " + count.toLocaleString());
  const unavailable = run.provider && run.provider !== "local" ? "The client reported no token counts for this attempt." : "";
  shown(id("agent-run-usage"),counts.length ? "Tokens · " + counts.join(" · ") : unavailable);
  shown(id("agent-run-notice"),run.notice);
}

export function createAgentSettings({api,toast,errorAt,onSaved}) {
  let information = null;
  let sequence = 0;
  let busy = false;
  let authenticating = false;
  const provider = id("agent-provider");
  const model = id("agent-model");
  const active = () => !id("agent-settings").hidden;

  function allowSave() {
    const picked = provider.value;
    const choice = picked === "local" ? "" : chosenModelId(picked,model.value);
    const current = information?.selected;
    id("agent-save").disabled = busy || !information || information.provider !== picked ||
      (current?.provider === picked && (current.model || "") === choice);
    id("agent-save").textContent = picked === "local" ? "Use local agent" : "Save agent";
  }

  function currentSelection(selected) {
    const name = agentLabel(selected?.provider);
    const modelName = selected?.model || (selected?.provider === "codex" ? codexDefault : selected?.provider === "local" ? "" : "provider default");
    shown(id("agent-current"),"Current selection · " + [name,modelName].filter(Boolean).join(" · "));
  }

  function paint(record,chosenModel) {
    const picked = record.provider;
    const definition = picked === "gemini" && record.client === "Gemini CLI"
      ? { ...agents.gemini, client:"Gemini CLI", install:"https://geminicli.com/" }
      : agents[picked];
    if (!definition) throw new Error("The planner returned an unknown task agent.");
    const remote = picked !== "local";
    information = record;
    provider.value = picked;
    currentSelection(record.selected);
    id("model-field").hidden = !remote;
    model.value = chosenModel;
    const suggestions = (Array.isArray(record.models) ? record.models : []).filter((item) => item && typeof item.id === "string");
    id("agent-models").replaceChildren(...suggestions.map((item) => new Option(item.label || item.id,item.id)));
    const defaultModel = picked === "codex" ? codexDefault : record.defaultModel;
    model.placeholder = defaultModel ? "Default · " + defaultModel : "Provider default";
    id("model-help").textContent = picked === "codex"
      ? "Choose a model or leave blank to use " + codexDefault + "."
      : "Choose a suggestion or enter a model ID. Leave blank for the provider default.";
    shown(id("agent-effort"),picked === "codex" && record.effort ? "Reasoning effort · " + record.effort : "");
    let label = "On-device estimation";
    if (remote) {
      if (!record.installed) label = definition.client + " is missing on this Mac.";
      else if (record.signedIn === true) label = "Signed in to " + definition.client;
      else if (record.signedIn === false) label = "Sign in to " + definition.client;
      else label = definition.client + " will check sign-in when it runs.";
    }
    id("agent-status").textContent = label;
    shown(id("agent-detail"),typeof record.detail === "string" ? record.detail : "");
    const accountInfo = [
      typeof record.plan === "string" && record.plan ? "Plan · " + record.plan : "",
      typeof record.quota === "string" && record.quota ? "Quota · " + record.quota : ""
    ].filter(Boolean);
    shown(id("agent-plan"),accountInfo.join("   /   "));
    const install = id("agent-install");
    install.hidden = !remote || Boolean(record.installed);
    if (remote && !record.installed) {
      install.href = definition.install;
      install.textContent = "Install " + definition.client;
    } else install.removeAttribute("href");
    const switchGemini = picked === "gemini" && record.signedIn === true && !suggestions.length;
    id("agent-login").hidden = !remote || !record.installed || (record.signedIn === true && !switchGemini);
    id("agent-login").textContent = switchGemini ? "Switch Google account in Terminal" : "Sign in in Terminal";
    id("agent-login").title = remote ? "Open " + definition.client + " in Terminal" : "";
    id("agent-login").disabled = authenticating;
    id("agent-check").hidden = !remote;
    id("agent-check").textContent = record.installed ? "Check sign-in" : "Check installation";
    id("agent-check").title = remote ? "Check " + definition.client + " on this Mac" : "";
    const sharing = remote
      ? "Each estimate sends the task text and date/time hints to " + definition.service + " through " + definition.client + ", using your signed-in subscription’s quota."
      : "Task estimation runs on this Mac.";
    shown(id("agent-sharing"),sharing);
    paintUsage(record.lastRun);
    allowSave();
  }

  async function load(picked,{keepModel = false, clearLogin = true} = {}) {
    const request = ++sequence;
    const previous = keepModel ? model.value : null;
    information = null;
    busy = true;
    allowSave();
    errorAt("settings-error");
    if (clearLogin) shown(id("agent-login-notice"),"");
    for (const key of ["agent-install","agent-login","agent-check","model-field","agent-detail","agent-plan","agent-sharing"]) id(key).hidden = true;
    id("agent-status").textContent = "Checking " + (picked ? agentLabel(picked) : "saved agent") + "…";
    try {
      let record = await api("/api/agent?provider=" + encodeURIComponent(picked || "local"));
      if (request !== sequence || !active()) return;
      if (!picked && record.selected?.provider && record.selected.provider !== record.provider) {
        provider.value = record.selected.provider;
        currentSelection(record.selected);
        id("agent-status").textContent = "Checking " + agentLabel(record.selected.provider) + "…";
        record = await api("/api/agent?provider=" + encodeURIComponent(record.selected.provider));
      }
      if (request !== sequence || !active()) return;
      const savedModel = record.selected?.provider === record.provider ? (record.selected.model || "") : "";
      paint(record,previous === null ? savedModel : previous);
    } catch (error) {
      if (request !== sequence || !active()) return;
      id("agent-status").textContent = "Agent details unavailable.";
      id("agent-check").hidden = false;
      id("agent-check").textContent = "Try again";
      errorAt("settings-error",error.message);
    } finally {
      if (request === sequence) { busy = false; allowSave(); }
    }
  }

  provider.addEventListener("change",() => load(provider.value));
  model.addEventListener("input",allowSave);
  id("agent-check").addEventListener("click",() => load(provider.value,{keepModel:true}));
  id("agent-login").addEventListener("click",async () => {
    const picked = provider.value;
    if (authenticating || picked === "local" || !information?.installed) return;
    authenticating = true;
    id("agent-login").disabled = true;
    errorAt("settings-error");
    try {
      const result = await api("/api/agent/login","POST",{provider:picked});
      if (!active() || provider.value !== picked) return;
      const changeLegacyAccount = picked === "gemini" && information?.client === "Gemini CLI" &&
        information.signedIn === true && !information.models?.length;
      shown(id("agent-login-notice"),changeLegacyAccount ? "In Gemini CLI, enter /auth and choose an eligible Google account. Then choose Check sign-in." :
        (result.message || "Finish sign-in in Terminal, then choose Check sign-in."));
    } catch (error) { if (active() && provider.value === picked) errorAt("settings-error",error.message); }
    finally { authenticating = false; id("agent-login").disabled = false; }
  });

  id("agent-form").addEventListener("submit",async (event) => {
    event.preventDefault();
    if (id("agent-save").disabled) return;
    const picked = provider.value;
    const choice = picked === "local" ? "" : chosenModelId(picked,model.value);
    if (choice && !/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,119}$/.test(choice)) {
      return errorAt("settings-error","Use a model ID of up to 120 characters. Start with a letter or number, and use letters, numbers, dots, underscores, colons, slashes, or hyphens.");
    }
    busy = true;
    provider.disabled = true;
    model.disabled = true;
    allowSave();
    errorAt("settings-error");
    try {
      await api("/api/agent","POST",{provider:picked,model:choice});
      if (active()) await load(picked);
      if (onSaved) await onSaved();
      toast("Task agent saved.");
    } catch (error) { if (active()) errorAt("settings-error",error.message); }
    finally { busy = false; provider.disabled = false; model.disabled = false; allowSave(); }
  });

  return () => load(null);
}
