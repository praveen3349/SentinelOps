let projects = [], activeProject = null, provider = 'github', activeDetailTab = 'overview', dockerStatus = null;
const $ = (id) => document.getElementById(id);
const architectureProfiles = {
  native: { title: 'Native server', text: 'Run directly as a managed service on your server. No containers required.' },
  container: { title: 'Containerized service', text: 'Generate a Docker image and compose-based deployment plan.' },
  kubernetes: { title: 'Kubernetes', text: 'Generate image, manifests, rollout strategy, and cluster deployment plan.' }
};

document.addEventListener('DOMContentLoaded', init);
async function init() {
  bindNavigation(); bindModal(); bindSettings(); bindDetail();
  window.api.onProjectTaskOutput(handleServiceOutput);
  window.api.onProjectTaskExit(handleServiceExit);
  window.api.onDockerTaskOutput(handleDockerOutput);
  window.api.onDockerTaskExit(handleDockerExit);
  projects = await window.api.getProjects();
  await loadSettings(); await refreshDockerStatus(); renderAll();
}

function bindNavigation() {
  document.querySelectorAll('.side-link').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  document.querySelectorAll('[data-view-target]').forEach(b => b.addEventListener('click', () => showView(b.dataset.viewTarget)));
  $('newProjectBtn').onclick = openProjectModal; $('heroNewProject').onclick = openProjectModal; $('projectNewButton').onclick = openProjectModal;
}
function showView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(view).classList.add('active');
  document.querySelectorAll('.side-link').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('crumb').textContent = view === 'projectDetail' ? (activeProject?.name || 'Project') : ({dashboard:'Overview',projects:'Projects',activity:'Activity',integrations:'Integrations',settings:'Settings'}[view] || 'Overview');
}
function renderAll() { $('projectCount').textContent = projects.length; $('metricProjects').textContent = projects.length; renderProjectRows(); renderTimeline(); }
function analysisFor(project) { return { ...(project.detection || {}), ...(project.aiAnalysis || {}), ...(project.orchestration?.detection || {}), services: project.orchestration?.detection?.services || project.aiAnalysis?.services || project.detection?.services || [] }; }
function servicesFor(project) {
  const d = analysisFor(project);
  if (Array.isArray(d.services) && d.services.length) return d.services;
  if (!d.installCommand && !d.runCommand) return [];
  return [{ id: 'root', name: d.framework || d.type || 'Application', directory: '.', kind: d.framework === 'React' || d.framework === 'Next.js' ? 'frontend' : 'backend', type: d.type, framework: d.framework, packageManager: d.packageManager || d.buildTool, requirementFile: d.requirementFile, installCommand: d.installCommand, runCommand: d.runCommand, port: 3000, url: 'http://localhost:3000' }];
}
function profileFor(project) { return project.orchestration?.profile || 'native'; }
function renderProjectRows() {
  const markup = projects.length ? projects.map(projectCard).join('') : emptyProjects();
  $('recentProjects').innerHTML = markup; $('projectsList').innerHTML = markup;
  document.querySelectorAll('[data-open-project]').forEach(b => b.onclick = () => openProject(b.dataset.openProject));
}
function projectCard(p) {
  const d = analysisFor(p), profile = architectureProfiles[profileFor(p)];
  const tags = [d.type || 'Unclassified', d.framework || d.buildTool || 'Repository'].filter(Boolean).slice(0, 2);
  return `<article class="project-row"><div class="repo-logo">${p.provider === 'gitlab' ? '◆' : '◉'}</div><div><h3>${esc(p.name)}</h3><p>${esc(p.repoUrl || p.path || 'Local repository')}</p></div><div class="project-cell"><span>Stack</span><div class="tag-row">${tags.map(x => `<b class="tag">${esc(x)}</b>`).join('')}</div></div><div class="project-cell"><span>Strategy</span><b>${profile.title}</b></div><div class="project-cell"><span>Health</span><b class="status-pill ready">● Ready</b></div><button class="secondary-btn" data-open-project="${p.id}">Open →</button></article>`;
}
function emptyProjects() { return `<div class="empty-projects"><h3>No repositories connected</h3><p>Start with a Git URL. Detection and pipeline planning happen automatically.</p><button class="primary-btn" onclick="document.getElementById('newProjectBtn').click()">Connect your first repository</button></div>`; }
function renderTimeline() {
  const defaults = [{ title:'SentinelOps ready', text:'The native analysis engine is online.', time:'Just now' }];
  const events = [...projects.map(p => ({title:`${p.name} analyzed`,text:`Technology profile generated from repository files.`,time:formatDate(p.addedAt)})), ...defaults];
  $('timeline').innerHTML = events.map((e,i) => `<div class="timeline-event"><span class="timeline-dot">${i ? '✓':'✦'}</span><div><h3>${esc(e.title)}</h3><p>${esc(e.text)}</p></div><time>${esc(e.time)}</time></div>`).join('');
}
function openProject(id) { activeProject = projects.find(p => p.id === id); if (!activeProject) return; activeDetailTab = 'overview'; renderDetail(); showView('projectDetail'); }
function renderDetail() {
  const p = activeProject, d = analysisFor(p), profile = architectureProfiles[profileFor(p)];
  $('detailName').textContent = p.name; $('detailMeta').textContent = `${p.provider || 'Git'} repository · ${d.activeBranch || p.gitInfo?.currentBranch || 'main'}`;
  $('stackHeading').textContent = d.projectKind || d.framework || d.type || 'Repository';
  $('stackCopy').textContent = `Detected ${d.type || 'application'} using ${d.packageManager || d.buildTool || 'the project build configuration'}. ${servicesFor(p).length > 1 ? 'Frontend and backend services must be installed and started separately.' : ''}`;
  $('stackTags').innerHTML = [d.type,d.framework,d.packageManager || d.buildTool].filter(Boolean).map(x => `<span class="tag">${esc(x)}</span>`).join('');
  $('detectProvider').textContent = d.provider ? `Analysis by ${d.provider}` : 'Rule-based repository detection';
  $('profileHeading').textContent = profile.title; $('profileCopy').textContent = profile.text;
  renderFlow(d, profile); renderPipeline(d); renderArchitecture(profileFor(p)); renderServiceRunner(); renderDockerWorkspace(); renderDeploymentWorkspace(); renderObservability(); switchDetailTab(activeDetailTab);
}
function renderFlow(d, profile) {
  const items = [['01','Checkout'],['02','Install'],['03',d.framework ? 'Build' : 'Validate'],['04','Test & scan'],['05',profile.title]];
  $('overviewFlow').innerHTML = items.map(([n,t]) => `<div class="flow-step"><span>${n}</span><b>${esc(t)}</b></div>`).join('');
}
function renderPipeline(d) {
  const delivery = activeProject.orchestration?.delivery || {};
  $('ciProvider').value = delivery.provider || recommendedCiProvider();
  $('observabilityEnabled').checked = delivery.observability !== false;
  $('pipelineNotice').textContent = localValidationPassed() ? 'Local validation confirmed. CI/CD assets can be generated.' : 'Complete local validation first. SentinelOps will then generate the selected CI/CD files.';
  const packageInstall = d.installCommand || d.suggestedCI?.[0] || 'Resolve dependencies';
  const ciName = ({ github: 'GitHub Actions', jenkins: 'Jenkins', gitlab: 'GitLab CI' })[delivery.provider || recommendedCiProvider()];
  const jobs = [['SOURCE','Checkout repository'],['BUILD',packageInstall],['VERIFY',d.suggestedCI?.find(x => /test/.test(x)) || 'Run quality checks'],['AUTOMATE',ciName],['RELEASE','Approval & deploy']];
  $('pipelineCanvas').innerHTML = jobs.map(([type,name]) => `<article class="pipe-job"><span>${type}</span><b>${esc(name)}</b><small>● Ready</small></article>`).join('');
}
function recommendedCiProvider() { return activeProject?.provider === 'gitlab' ? 'gitlab' : activeProject?.provider === 'github' ? 'github' : 'jenkins'; }
function localValidationPassed() { return Boolean(activeProject?.orchestration?.localValidation?.passed); }
function renderArchitecture(selected) {
  $('architectureChoices').innerHTML = Object.entries(architectureProfiles).map(([key,p]) => `<button class="architecture-choice ${key===selected?'active':''}" data-profile="${key}"><span>${key===selected?'◉':'○'}</span><div><b>${p.title}</b><small>${p.text}</small></div><span>›</span></button>`).join('');
  document.querySelectorAll('[data-profile]').forEach(b => b.onclick = () => saveProfile(b.dataset.profile));
}
async function saveProfile(profile) {
  activeProject = await window.api.updateProjectConfig(activeProject.id, {profile});
  projects = projects.map(p => p.id === activeProject.id ? activeProject : p); renderAll(); renderDetail(); toast(`Deployment profile changed to ${architectureProfiles[profile].title}.`);
}
async function renderDeploymentWorkspace() {
  if (!activeProject || !$('deploymentRecommendation')) return;
  const saved = activeProject.orchestration?.deployment;
  const scale = saved?.scale || {};
  $('minReplicas').value = scale.minReplicas || 2; $('maxReplicas').value = scale.maxReplicas || 8; $('targetCpu').value = scale.targetCpu || 70;
  $('deploymentNotice').textContent = localValidationPassed() ? (saved?.generatedAt ? `Deployment assets generated in ${saved.directory}.` : 'Confirm your deployment profile and capacity policy to generate reviewable assets.') : 'Complete local validation before deployment generation.';
  const nodes = ['Validated app', architectureProfiles[profileFor(activeProject)].title, ...(profileFor(activeProject) === 'kubernetes' ? ['Deployment', 'HPA autoscaler'] : ['Managed service'])];
  $('deploymentMap').innerHTML = nodes.map((node, index) => `<span>${esc(node)}</span>${index < nodes.length - 1 ? '<i>→</i>' : ''}`).join('');
  const requestedId = activeProject.id;
  const result = await window.api.getDeploymentRecommendation(requestedId);
  if (!activeProject || activeProject.id !== requestedId || !result) return;
  $('deploymentRecommendation').textContent = `${architectureProfiles[result.profile].title} recommended`;
  $('deploymentReason').textContent = result.reason;
  document.querySelectorAll('[data-profile]').forEach((button) => button.classList.toggle('recommended', button.dataset.profile === result.profile));
}
async function generateDeploymentAssets() {
  const profile = profileFor(activeProject);
  const scale = { minReplicas: $('minReplicas').value, maxReplicas: $('maxReplicas').value, targetCpu: $('targetCpu').value };
  const result = await window.api.generateDeploymentAssets({ projectId: activeProject.id, profile, scale });
  if (!result.success) { $('deploymentNotice').textContent = result.error; toast(result.error); return; }
  activeProject = result.project; projects = projects.map((item) => item.id === activeProject.id ? activeProject : item); renderDetail();
  $('deploymentNotice').textContent = `Generated ${result.assets.map((asset) => asset.type).join(', ')} in ${result.directory}.`;
  toast('Deployment and maintenance assets are ready for review.');
}
function bindDetail() {
  document.querySelectorAll('.detail-tab').forEach(b => b.onclick = () => switchDetailTab(b.dataset.detailTab));
  $('editDetection').onclick = openEditModal; $('editProfile').onclick = () => switchDetailTab('deployment');
  $('saveDetection').onclick = saveDetection; $('runPipelineBtn').onclick = runPipeline; $('refreshPlan').onclick = () => { renderDetail(); toast('Pipeline plan regenerated from the current project profile.'); };
  $('openWorkbench').onclick = () => switchDetailTab('localRun');
  $('deleteProjectBtn').onclick = deleteActiveProject;
  $('confirmLocalValidationBtn').onclick = confirmLocalValidation;
  $('generatePipelineBtn').onclick = generatePipelineAssets;
  $('generateDeploymentBtn').onclick = generateDeploymentAssets;
  $('refreshHealthBtn').onclick = refreshHealthChecks;
}
function switchDetailTab(tab) { activeDetailTab = tab; document.querySelectorAll('.detail-tab').forEach(b=>b.classList.toggle('active',b.dataset.detailTab===tab)); document.querySelectorAll('.detail-panel').forEach(p=>p.classList.remove('active')); $('detail'+cap(tab)).classList.add('active'); }
function cap(s) { return s.charAt(0).toUpperCase()+s.slice(1); }
function openEditModal() { const d=analysisFor(activeProject); $('editType').value=d.type||''; $('editFramework').value=d.framework||''; $('editBuildTool').value=d.packageManager||d.buildTool||''; $('editModal').classList.remove('hidden'); }
async function saveDetection() { const old=analysisFor(activeProject); const detection={...old,type:$('editType').value.trim(),framework:$('editFramework').value.trim(),packageManager:$('editBuildTool').value.trim(),buildTool:$('editBuildTool').value.trim(),provider:'Human-confirmed profile'}; activeProject=await window.api.updateProjectConfig(activeProject.id,{detection}); projects=projects.map(p=>p.id===activeProject.id?activeProject:p); $('editModal').classList.add('hidden'); renderAll(); renderDetail(); toast('Technology profile saved. Pipeline plan updated.'); }
function runPipeline() { switchDetailTab('pipeline'); const log=$('runLog'), state=$('pipelineState'); state.textContent='Running simulated validation'; const d=analysisFor(activeProject); log.textContent=`[00:00] Pipeline queued for ${activeProject.name}\n[00:01] ✓ Repository checkout complete\n[00:02] ✓ Planned install: ${d.installCommand || 'dependencies resolved'}\n[00:03] ✓ Build strategy validated\n[00:04] ✓ Quality gate configured\n\nThis is a safe plan preview. Connect a CI runner in Integrations to execute commands on approved infrastructure.`; setTimeout(()=>{state.textContent='Plan validated';toast('Pipeline plan validated — no commands were run on this machine.');},500); }
async function refreshDockerStatus() { dockerStatus = await window.api.getDockerStatus(); if (activeProject) renderDockerWorkspace(); return dockerStatus; }
function dockerBaseImage(service) { if (/Python/i.test(service.type || '')) return 'python:3.12-slim'; if (/Go/i.test(service.type || '')) return 'golang:1.22-alpine'; if (/Rust/i.test(service.type || '')) return 'rust:1.78-slim'; return 'node:20-alpine'; }
function renderDockerWorkspace() {
  if (!activeProject || !$('dockerStatus')) return;
  const services = servicesFor(activeProject);
  const status = dockerStatus || { installed: false, running: false, message: 'Checking Docker Desktop…' };
  $('dockerStatus').className = `docker-status ${status.running ? 'ready' : status.installed ? 'warning' : 'offline'}`;
  $('dockerStatus').textContent = status.running ? `Docker ready · Engine ${status.engineVersion || ''}` : status.message;
  $('dockerVisual').innerHTML = services.length ? services.map((service, index) => `<div class="docker-node repo"><span>01</span><b>${esc(service.name)}</b><small>${esc(service.framework || service.type || 'Application')}</small></div><i class="docker-arrow">→</i><div class="docker-node image"><span>02</span><b>${esc(dockerBaseImage(service))}</b><small>Base image</small></div><i class="docker-arrow">→</i><div class="docker-node container"><span>03</span><b>${esc(service.name)} container</b><small>${esc(service.url || 'No web port detected')}</small></div>${index < services.length - 1 ? '<div class="docker-divider"></div>' : ''}`).join('') : `<div class="docker-empty">Confirm the project technology profile to generate a Docker plan.</div>`;
  const validated = localValidationPassed();
  const missingDockerNote = status.installed ? 'Start Docker Desktop, then check its status again.' : 'Docker Desktop is required on Windows. Install and start it outside SentinelOps, then refresh this status.';
  if (!validated) $('dockerActions').innerHTML = `<span class="docker-help">Complete Step 1: local validation, before generating or running containers.</span>`;
  else if (!status.running) $('dockerActions').innerHTML = `<button id="refreshDockerBtn" class="primary-btn">Check Docker status</button><span class="docker-help">${missingDockerNote}</span>`;
  else $('dockerActions').innerHTML = `<button id="generateDockerBtn" class="primary-btn">Generate Docker assets</button><button id="refreshDockerBtn" class="secondary-btn">Refresh status</button><span class="docker-help">Creates .sentinelops/Dockerfile and .sentinelops-compose.yml without overwriting source files.</span>`;
  $('dockerServices').innerHTML = services.map((service) => `<article class="docker-service"><div><h3>${esc(service.name)}</h3><p>${esc(service.directory || '.')} · ${esc(dockerBaseImage(service))} · ${esc(service.port ? `port ${service.port}` : 'no exposed port')}</p></div><div class="docker-service-actions"><button class="secondary-btn" data-docker-action="pull" data-docker-service="${esc(service.id)}" ${status.running && validated ? '' : 'disabled'}>Pull base image</button><button class="secondary-btn" data-docker-action="build" data-docker-service="${esc(service.id)}" ${status.running && validated ? '' : 'disabled'}>Build image</button><button class="primary-btn" data-docker-action="run" data-docker-service="${esc(service.id)}" ${status.running && validated ? '' : 'disabled'}>Run container</button></div></article>`).join('');
  $('refreshDockerBtn')?.addEventListener('click', refreshDockerStatus); $('generateDockerBtn')?.addEventListener('click', generateDockerAssets);
  document.querySelectorAll('[data-docker-action]').forEach(button => button.addEventListener('click', () => runDockerTask(button.dataset.dockerService, button.dataset.dockerAction)));
}
async function generateDockerAssets() { const result = await window.api.prepareDockerProject(activeProject.id); if (!result.success) { toast(result.error); return; } activeProject = result.project; projects = projects.map(p => p.id === activeProject.id ? activeProject : p); renderAll(); renderDetail(); $('dockerOutput').textContent = `Docker assets generated:\n${result.assets.generated.map(item => `- ${item.dockerfilePath}\n  Image: ${item.image}\n  Base: ${item.baseImage}`).join('\n')}\n\nCompose file: ${result.assets.composePath}\n`; toast('Docker assets generated from the selected stack.'); }
async function runDockerTask(serviceId, action) { const result = await window.api.runDockerTask({ projectId: activeProject.id, serviceId, action }); if (!result.success) { $('dockerOutput').textContent += `[SentinelOps] ${result.error}\n`; toast(result.error); return; } $('dockerOutput').textContent += `\nStarting Docker ${action}…\n`; }
function handleDockerOutput(payload) { if (payload.projectId && payload.projectId !== activeProject?.id) return; const output = $('dockerOutput'); if (!output) return; output.textContent += payload.data; output.scrollTop = output.scrollHeight; }
async function handleDockerExit(payload) { if (payload.projectId && payload.projectId !== activeProject?.id) return; const output = $('dockerOutput'); if (output) output.textContent += `\n[Docker ${payload.action} exited with code ${payload.code}]\n`; if (payload.action === 'run' && payload.code === 0) toast(payload.url ? `Container is running at ${payload.url}` : 'Container is running.'); }
function renderServiceRunner() {
  const services = servicesFor(activeProject);
  $('localValidationNotice').textContent = localValidationPassed() ? `Local validation confirmed ${formatDate(activeProject.orchestration.localValidation.confirmedAt)}. Docker and deployment automation are unlocked.` : 'Install and start the application, open its local URL, then confirm that it works.';
  $('confirmLocalValidationBtn').textContent = localValidationPassed() ? 'Local test confirmed' : 'Confirm local test passed';
  $('confirmLocalValidationBtn').disabled = localValidationPassed();
  $('serviceRunner').innerHTML = services.length ? services.map(service => `<article class="service-card"><div class="service-card-top"><div><h3>${esc(service.name)}</h3><p>${esc(service.kind || 'service')} · ${esc(service.framework || service.type || 'Unknown')} · ${esc(service.directory || '.')}</p></div><span class="service-state" data-service-state="${esc(service.id)}">STOPPED</span></div><div class="service-command">Install: ${esc(service.installCommand || 'No dependency file detected')}</div><div class="service-command">Start: ${esc(service.runCommand || 'No runnable command detected')}</div><div class="service-actions"><button class="secondary-btn" data-task="install" data-service="${esc(service.id)}" ${service.installCommand ? '' : 'disabled'}>Install requirements</button><button class="primary-btn" data-task="start" data-service="${esc(service.id)}" ${service.runCommand ? '' : 'disabled'}>Start service</button><button class="secondary-btn hidden" data-task="stop" data-service="${esc(service.id)}">Stop</button></div><div class="service-url">Expected URL: <a href="${esc(service.url || '')}" data-service-url="${esc(service.id)}">${esc(service.url || 'Not detected')}</a></div><pre class="service-output" data-service-output="${esc(service.id)}"></pre></article>`).join('') : `<div class="empty-projects"><h3>No runnable service was detected</h3><p>Confirm the technology profile and add a supported package manifest or requirements.txt file.</p></div>`;
  document.querySelectorAll('[data-task]').forEach(button => button.onclick = () => runServiceTask(button.dataset.service, button.dataset.task));
}
async function confirmLocalValidation() {
  if (!activeProject) return;
  const confirmed = window.confirm('Confirm that you installed and tested the detected services locally. This unlocks Docker and CI/CD asset generation.');
  if (!confirmed) return;
  const project = await window.api.confirmLocalValidation(activeProject.id);
  if (!project) { toast('Could not save local validation status.'); return; }
  activeProject = project; projects = projects.map((item) => item.id === project.id ? project : item); renderDetail(); toast('Local validation confirmed. Container and CI/CD steps are unlocked.');
}
async function generatePipelineAssets() {
  const provider = $('ciProvider').value;
  const observability = $('observabilityEnabled').checked;
  const result = await window.api.generatePipelineAssets({ projectId: activeProject.id, provider, observability });
  if (!result.success) { toast(result.error); $('pipelineNotice').textContent = result.error; return; }
  activeProject = result.project; projects = projects.map((item) => item.id === activeProject.id ? activeProject : item); renderDetail();
  $('pipelineNotice').textContent = `Generated ${result.assets.map((asset) => asset.type).join(', ')} in ${result.generatedDir}.`;
  toast('CI/CD and observability assets generated for review.');
}
function renderObservability() {
  const delivery = activeProject?.orchestration?.delivery;
  const provider = ({ github: 'GitHub Actions', jenkins: 'Jenkins', gitlab: 'GitLab CI' })[delivery?.provider] || ({ github: 'GitHub Actions', jenkins: 'Jenkins', gitlab: 'GitLab CI' })[recommendedCiProvider()];
  const services = servicesFor(activeProject);
  const monitoring = delivery?.observability !== false;
  $('observabilityHeading').textContent = delivery?.generatedAt ? 'Grafana + Prometheus assets generated' : 'Monitoring plan ready';
  $('toolchainHeading').textContent = `${provider} delivery plan`;
  $('toolchainCopy').textContent = delivery?.generatedAt ? `${provider} automation is generated for review. ${monitoring ? 'Prometheus scrape configuration and a Grafana dashboard are ready.' : 'Monitoring asset generation was disabled.'}` : `SentinelOps recommends ${provider} from the repository provider. Confirm local validation to generate its files.`;
  const nodes = ['Repository', 'Local test', provider, 'Docker delivery', ...(monitoring ? ['Prometheus', 'Grafana'] : [])];
  $('deliveryVisual').innerHTML = nodes.map((node, index) => `<span class="delivery-node ${index === 0 ? 'source' : ''}">${esc(node)}</span>${index < nodes.length - 1 ? '<i>→</i>' : ''}`).join('');
  if (services.length) $('deliveryVisual').title = `Detected services: ${services.map((service) => service.name).join(', ')}`;
  $('healthChecks').innerHTML = services.filter((service) => service.url).length ? services.filter((service) => service.url).map((service) => `<div class="health-row" data-health="${esc(service.id)}"><span class="health-dot idle"></span><b>${esc(service.name)}</b><small>${esc(service.url)}</small><em>Not checked</em></div>`).join('') : '<p class="empty-health">No HTTP endpoint was detected for this project.</p>';
}
async function refreshHealthChecks() {
  if (!activeProject) return;
  $('refreshHealthBtn').disabled = true; $('refreshHealthBtn').textContent = 'Checking…';
  const results = await window.api.probeProjectHealth(activeProject.id);
  for (const result of results) {
    const row = document.querySelector(`[data-health="${cssEscape(result.serviceId)}"]`);
    if (!row) continue;
    const dot = row.querySelector('.health-dot'); const status = row.querySelector('em');
    dot.className = `health-dot ${result.status}`;
    status.textContent = result.status === 'healthy' ? `${result.statusCode} · ${result.latencyMs} ms` : result.error || result.status;
  }
  $('refreshHealthBtn').disabled = false; $('refreshHealthBtn').textContent = 'Refresh checks';
  if (results.some((result) => result.status !== 'healthy')) toast('One or more health checks need attention. Review the service state and runbook.');
}
async function runServiceTask(serviceId, action) {
  if (action === 'stop') { await window.api.stopProjectService({projectId: activeProject.id, serviceId}); setServiceState(serviceId, 'STOPPED'); return; }
  const result = await window.api.runProjectTask({ projectId: activeProject.id, serviceId, action });
  if (!result.success) { appendServiceOutput(serviceId, `[SentinelOps] ${result.error}\n`); setServiceState(serviceId, 'ERROR'); return; }
  if (action === 'start') setServiceState(serviceId, 'STARTING');
  else toast('Requirements installation started. Follow its live output below.');
}
function handleServiceOutput({projectId, serviceId, data}) {
  if (!activeProject || activeProject.id !== projectId) return;
  appendServiceOutput(serviceId, data);
  const url = extractUrl(data);
  if (url) { const link = document.querySelector(`[data-service-url="${cssEscape(serviceId)}"]`); if (link) { link.href = url; link.textContent = url; } setServiceState(serviceId, 'RUNNING'); }
}
function handleServiceExit({projectId, serviceId, code}) { if (activeProject?.id === projectId) setServiceState(serviceId, code === 0 ? 'STOPPED' : 'ERROR'); }
function appendServiceOutput(serviceId, data) { const out=document.querySelector(`[data-service-output="${cssEscape(serviceId)}"]`); if(out){out.textContent+=data;out.scrollTop=out.scrollHeight;} }
function setServiceState(serviceId, state) { const label=document.querySelector(`[data-service-state="${cssEscape(serviceId)}"]`); if(!label)return; label.textContent=state;label.className=`service-state ${state === 'RUNNING' || state === 'STARTING' ? 'running' : state === 'ERROR' ? 'error' : ''}`; const card=label.closest('.service-card'); card.querySelector('[data-task="start"]').classList.toggle('hidden',state === 'RUNNING' || state === 'STARTING');card.querySelector('[data-task="stop"]').classList.toggle('hidden',!(state === 'RUNNING' || state === 'STARTING')); }
function extractUrl(data) { const match = String(data).match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s]*)?/i); return match ? match[0].replace('0.0.0.0','localhost') : null; }
async function deleteActiveProject() { if(!activeProject)return; const answer=window.confirm(`Delete the cloned repository folder for "${activeProject.name}"?\n\nThis permanently removes:\n${activeProject.path}\n\nThis cannot be undone.`); if(!answer)return; const result=await window.api.deleteClonedProject(activeProject.id); if(!result.success){toast(result.error);return;} projects=result.projects;activeProject=null;renderAll();showView('projects');toast('The cloned repository and its SentinelOps project record were deleted.'); }
function bindModal() {
  $('browseBtn').onclick = async () => { const folder=await window.api.selectDirectory(); if(folder) $('destPath').value=folder; };
  document.querySelectorAll('.provider-choice').forEach(b=>b.onclick=()=>{provider=b.dataset.provider;document.querySelectorAll('.provider-choice').forEach(x=>x.classList.toggle('active',x===b));});
  document.querySelector('[data-close-modal]').onclick=closeProjectModal; document.querySelector('[data-close-edit]').onclick=()=>$('editModal').classList.add('hidden');
  $('cloneBtn').onclick=cloneProject;
}
function openProjectModal() { $('repoUrl').value='';$('destPath').value='';$('modalStatus').textContent='';$('projectModal').classList.remove('hidden'); }
function closeProjectModal() { $('projectModal').classList.add('hidden'); }
async function cloneProject() {
  const repoUrl=$('repoUrl').value.trim(), destParentPath=$('destPath').value.trim(); if(!repoUrl||!destParentPath){$('modalStatus').textContent='Add both a repository URL and a local destination.';return;}
  $('cloneBtn').disabled=true;$('cloneBtn').textContent='Cloning & analyzing…';$('modalStatus').textContent='Repository intake in progress…';
  window.api.onCloneProgress(msg=>$('modalStatus').textContent=msg);
  const result=await window.api.cloneRepo({repoUrl,provider,destParentPath,useSavedCredentials:true}); $('cloneBtn').disabled=false;$('cloneBtn').innerHTML='Analyze repository <span>→</span>';
  if(!result.success){$('modalStatus').textContent=result.error||'The repository could not be analyzed.';return;} projects.unshift(result.project); closeProjectModal(); renderAll(); openProject(result.project.id); toast('Repository analyzed. Confirm the generated delivery plan.');
}
function bindSettings() { $('saveSettings').onclick=async()=>{await window.api.saveApiConfig({provider:$('aiProvider').value,apiKey:$('apiKey').value.trim()});$('settingsMessage').textContent='Saved';setTimeout(()=>$('settingsMessage').textContent='',2000);}; }
async function loadSettings() { const c=await window.api.getApiConfig(); $('aiProvider').value=c?.provider||'native'; $('apiKey').value=c?.apiKey||''; }
function toast(message) { const t=$('toast');t.textContent=message;t.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.classList.remove('show'),3500); }
function esc(v){return String(v??'').replace(/[&<>'"]/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[x]));} function formatDate(v){return v?new Date(v).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'Recently';}
function cssEscape(v){return String(v).replace(/(["\\])/g,'\\$1');}
