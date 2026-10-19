const fs = require('fs');
const path = require('path');
const https = require('https');

/**
 * Safely reads file text or returns empty string if missing
 */
function readSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return '';
  }
}

/**
 * Checks if file exists in directory
 */
function exists(dir, file) {
  return fs.existsSync(path.join(dir, file));
}

const IGNORE_DIRECTORIES = new Set(['.git', 'node_modules', 'venv', '.venv', '__pycache__', 'dist', 'build', '.next', 'coverage']);

function readPackageJson(directory) {
  try { return JSON.parse(readSafe(path.join(directory, 'package.json'))); } catch (e) { return null; }
}

function packageManagerFor(directory) {
  if (exists(directory, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(directory, 'yarn.lock')) return 'yarn';
  return 'npm';
}

function inspectNodeService(directory, relativeDirectory, role) {
  const pkg = readPackageJson(directory);
  if (!pkg) return null;
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const manager = packageManagerFor(directory);
  let framework = 'Node.js';
  let kind = role || 'service';
  if (deps.next) { framework = 'Next.js'; kind = 'frontend'; }
  else if (deps.react || deps.vue || deps['@angular/core'] || deps.svelte) { framework = deps.vue ? 'Vue.js' : deps['@angular/core'] ? 'Angular' : deps.svelte ? 'Svelte' : 'React'; kind = 'frontend'; }
  else if (deps.express) { framework = 'Express'; kind = 'backend'; }
  else if (deps.fastify) { framework = 'Fastify'; kind = 'backend'; }
  else if (deps.koa) { framework = 'Koa'; kind = 'backend'; }
  const installCommand = manager === 'yarn' ? 'yarn install --frozen-lockfile' : manager === 'pnpm' ? 'pnpm install --frozen-lockfile' : 'npm ci';
  const fallbackInstall = manager === 'yarn' ? 'yarn install' : manager === 'pnpm' ? 'pnpm install' : 'npm install';
  const scripts = pkg.scripts || {};
  const startScript = scripts.dev ? (manager === 'yarn' ? 'yarn dev' : `${manager} run dev`) : scripts.start ? (manager === 'yarn' ? 'yarn start' : `${manager} start`) : null;
  const entryContent = pkg.main ? readSafe(path.join(directory, pkg.main)) : '';
  let port = framework === 'Next.js' || kind === 'frontend' ? 3000 : null;
  if (deps.electron) { framework = 'Electron'; kind = 'desktop'; }
  else if (kind === 'service' && /\.listen\s*\(/.test(entryContent)) {
    kind = 'backend';
    const portMatch = entryContent.match(/(?:PORT\s*\|\||listen\s*\()\s*(\d{2,5})/);
    port = portMatch ? Number(portMatch[1]) : 3001;
  }
  const displayName = relativeDirectory ? `${kind === 'frontend' ? 'Frontend' : kind === 'backend' ? 'Backend' : 'Application'} (${relativeDirectory})` : framework;
  return { id: relativeDirectory || 'root', name: displayName, directory: relativeDirectory || '.', kind, type: 'Node.js', framework, packageManager: manager, requirementFile: 'package.json', installCommand: exists(directory, 'package-lock.json') || exists(directory, 'yarn.lock') || exists(directory, 'pnpm-lock.yaml') ? installCommand : fallbackInstall, runCommand: startScript || (pkg.main ? `node ${pkg.main}` : ''), entryFile: pkg.main || 'package.json', port, url: port ? `http://localhost:${port}` : '', detectedFiles: ['package.json'] };
}

function inspectPythonService(directory, relativeDirectory, role) {
  const requirementFile = exists(directory, 'requirements.txt') ? 'requirements.txt' : exists(directory, 'pyproject.toml') ? 'pyproject.toml' : exists(directory, 'Pipfile') ? 'Pipfile' : null;
  if (!requirementFile) return null;
  const candidates = ['manage.py', 'main.py', 'app.py', 'server.py', 'api.py', 'run.py'];
  const entryFile = candidates.find((file) => exists(directory, file)) || '';
  const content = entryFile ? readSafe(path.join(directory, entryFile)) : '';
  let framework = 'Python'; let runCommand = entryFile ? `python ${entryFile}` : '';
  let port = 8000;
  if (entryFile === 'manage.py') { framework = 'Django'; runCommand = 'python manage.py runserver'; port = 8000; }
  else if (/FastAPI/i.test(content)) { framework = 'FastAPI'; runCommand = `uvicorn ${entryFile.replace(/\.py$/, '')}:app --reload`; port = 8000; }
  else if (/Flask/i.test(content)) { framework = 'Flask'; runCommand = `flask --app ${entryFile.replace(/\.py$/, '')} run`; port = 5000; }
  return { id: relativeDirectory || 'root', name: relativeDirectory ? `Backend (${relativeDirectory})` : framework, directory: relativeDirectory || '.', kind: role || 'backend', type: 'Python', framework, packageManager: 'pip', requirementFile, installCommand: requirementFile === 'requirements.txt' ? 'python -m pip install -r requirements.txt' : requirementFile === 'Pipfile' ? 'pipenv install' : 'python -m pip install .', runCommand, entryFile, port, url: `http://localhost:${port}`, detectedFiles: [requirementFile, entryFile].filter(Boolean) };
}

function findCandidateDirectories(rootPath) {
  const candidates = [{ directory: rootPath, relative: '', role: null }];
  const visit = (directory, relative, depth) => {
    if (depth > 2) return;
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || IGNORE_DIRECTORIES.has(entry.name)) continue;
        const lower = entry.name.toLowerCase();
        const role = ['frontend', 'front-end', 'client', 'web', 'ui'].includes(lower) ? 'frontend' : ['backend', 'back-end', 'server', 'api', 'services'].includes(lower) ? 'backend' : null;
        const child = path.join(directory, entry.name);
        const childRelative = relative ? path.join(relative, entry.name) : entry.name;
        if (role || exists(child, 'package.json') || exists(child, 'requirements.txt') || exists(child, 'pyproject.toml')) candidates.push({ directory: child, relative: childRelative, role });
        visit(child, childRelative, depth + 1);
      }
    } catch (e) {}
  };
  visit(rootPath, '', 1);
  return candidates;
}

/**
 * Rule-based fallback engine for instant offline / zero-key stack & branch detection
 */
function runFallbackAnalysis(rootPath, gitInfo = {}) {
  const services = [];
  for (const candidate of findCandidateDirectories(rootPath)) {
    const service = inspectNodeService(candidate.directory, candidate.relative, candidate.role) || inspectPythonService(candidate.directory, candidate.relative, candidate.role);
    if (service && !services.some((existing) => existing.directory === service.directory)) services.push(service);
  }
  if (!services.length && exists(rootPath, 'go.mod')) services.push({ id: 'root', name: 'Go service', directory: '.', kind: 'backend', type: 'Go', framework: 'Go Module', packageManager: 'go mod', requirementFile: 'go.mod', installCommand: 'go mod download', runCommand: 'go run .', entryFile: 'main.go', port: 8080, url: 'http://localhost:8080', detectedFiles: ['go.mod'] });
  if (!services.length && exists(rootPath, 'Cargo.toml')) services.push({ id: 'root', name: 'Rust service', directory: '.', kind: 'backend', type: 'Rust', framework: 'Cargo', packageManager: 'cargo', requirementFile: 'Cargo.toml', installCommand: 'cargo build', runCommand: 'cargo run', entryFile: 'src/main.rs', port: 8000, url: 'http://localhost:8000', detectedFiles: ['Cargo.toml'] });
  const primary = services[0] || {};
  const hasFrontend = services.some((item) => item.kind === 'frontend');
  const hasBackend = services.some((item) => item.kind === 'backend');
  const projectKind = hasFrontend && hasBackend ? 'Full-stack application' : hasFrontend ? 'Frontend application' : hasBackend ? 'Backend service' : primary.framework ? `${primary.framework} application` : 'Unclassified repository';
  const activeBranch = gitInfo.currentBranch || 'main';
  const highlights = [`${projectKind} detected from ${services.length} runnable service${services.length === 1 ? '' : 's'}.`, ...services.map((service) => `${service.name}: ${service.framework} in ${service.directory}`)];
  if (exists(rootPath, 'Dockerfile')) highlights.push('Dockerfile found — container deployment is available.');
  const accessNotes = services.filter((service) => service.url).map((service) => `${service.name} will be available at ${service.url}`);
  return { success: true, provider: 'Built-in SentinelOps Engine', projectKind, type: primary.type || 'Unknown', framework: primary.framework || 'Generic / Native', packageManager: primary.packageManager || 'None', requirementFile: primary.requirementFile || '', entryFile: primary.entryFile || '', installCommand: primary.installCommand || '', runCommand: primary.runCommand || '', activeBranch, branches: gitInfo.branches || [activeBranch], branchSummary: `Branch "${activeBranch}" active. ${projectKind} analysis completed.`, highlights, detectedFiles: [...new Set(services.flatMap((service) => service.detectedFiles || []))], services, aiRecommendation: services.length ? `Install and start each detected service separately.${accessNotes.length ? ` ${accessNotes.join(' ')}` : ''}` : 'No supported runnable service was found. Confirm the project profile manually.' };
}

/**
 * Call Free LLM (Google Gemini Free API)
 */
async function callFreeLLMAPI({ provider, apiKey, prompt }) {
  if (provider === 'gemini' && apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    });

    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) resolve(text);
            else reject(new Error('No response text from Gemini API'));
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  throw new Error('No supported external LLM key provided.');
}

/**
 * Main AI Analyzer function for SentinelOps
 */
async function aiAnalyzeRepository({ rootPath, gitInfo = {}, apiConfig = {} }) {
  const fallbackResult = runFallbackAnalysis(rootPath, gitInfo);

  if (!apiConfig.apiKey) {
    return fallbackResult;
  }

  try {
    const fileList = fs.readdirSync(rootPath).slice(0, 30).join(', ');
    const reqContent = fallbackResult.requirementFile ? readSafe(path.join(rootPath, fallbackResult.requirementFile)).slice(0, 1000) : '';

    const prompt = `You are SentinelOps AI DevOps Assistant. Analyze this code repository:
Files in root: ${fileList}
Active Git Branch: ${fallbackResult.activeBranch}
Detected Stack: ${fallbackResult.type} (${fallbackResult.framework})
Requirement File Content:
${reqContent}

Respond in JSON format with fields:
- type (string)
- framework (string)
- packageManager (string)
- requirementFile (string)
- entryFile (string)
- installCommand (string)
- runCommand (string)
- branchSummary (string)
- aiRecommendation (string)
`;

    const rawResponse = await callFreeLLMAPI({
      provider: apiConfig.provider || 'gemini',
      apiKey: apiConfig.apiKey,
      prompt
    });

    const cleanJsonStr = rawResponse.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanJsonStr);

    return {
      ...fallbackResult,
      provider: `AI Provider (${apiConfig.provider || 'Gemini Free'})`,
      ...parsed
    };
  } catch (e) {
    console.warn('LLM API call failed, falling back to SentinelOps native analysis:', e.message);
    return fallbackResult;
  }
}

/**
 * AI Error Solver: Diagnoses execution error log and generates self-healing fix
 */
async function aiSolveError({ errorLog, projectInfo = {}, apiConfig = {} }) {
  if (!errorLog || errorLog.trim().length === 0) {
    return {
      errorTitle: 'No Error Log',
      rootCause: 'No execution log output was captured.',
      solution: 'Please run the application first to capture any runtime output or error stack trace.',
      fixCommand: ''
    };
  }

  const logExcerpt = errorLog.slice(-2000);

  if (apiConfig.apiKey) {
    try {
      const prompt = `You are SentinelOps Self-Healing AI DevOps Engineer.
The following runtime error occurred when executing the project "${projectInfo.name || 'Application'}":

--- LOG EXCERPT ---
${logExcerpt}
--- END LOG EXCERPT ---

Analyze the root cause and provide a solution.
Respond in JSON format with fields:
- errorTitle (string, e.g. "Module Missing: flask")
- rootCause (string, clear summary of what failed)
- solution (string, detailed steps to resolve)
- fixCommand (string, exact shell command to run to fix the issue, e.g. "pip install flask" or "npm install express" or "")
`;

      const rawResponse = await callFreeLLMAPI({
        provider: apiConfig.provider || 'gemini',
        apiKey: apiConfig.apiKey,
        prompt
      });

      const cleanJsonStr = rawResponse.replace(/```json/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleanJsonStr);
    } catch (err) {
      console.warn('LLM Error Solver call failed, using native solver:', err.message);
    }
  }

  // Built-in Native Rule-based Error Solver Fallback
  let errorTitle = 'Runtime Error Encountered';
  let rootCause = 'An unhandled exception or process exit occurred during execution.';
  let solution = 'Review the stack trace below. Verify dependencies are installed and configuration parameters are correct.';
  let fixCommand = '';

  if (logExcerpt.includes('ModuleNotFoundError') || logExcerpt.includes('No module named')) {
    const match = logExcerpt.match(/No module named ['"]([^'"]+)['"]/);
    const mod = match ? match[1] : 'missing package';
    errorTitle = `Missing Python Package: ${mod}`;
    rootCause = `The required Python module "${mod}" is not installed in the current environment.`;
    solution = `Install the missing module using pip or update your requirements.txt file.`;
    fixCommand = `pip install ${mod}`;
  } else if (logExcerpt.includes('Cannot find module') || logExcerpt.includes('MODULE_NOT_FOUND')) {
    const match = logExcerpt.match(/Cannot find module ['"]([^'"]+)['"]/);
    const mod = match ? match[1] : 'missing module';
    errorTitle = `Missing Node Module: ${mod}`;
    rootCause = `The npm package "${mod}" could not be located in node_modules.`;
    solution = `Run npm install to pull in missing dependencies.`;
    fixCommand = `npm install ${mod}`;
  } else if (logExcerpt.includes('EADDRINUSE') || logExcerpt.includes('address already in use')) {
    errorTitle = 'Network Port Conflict (EADDRINUSE)';
    rootCause = 'The server port is already being used by another running process.';
    solution = 'Stop the process running on that port or change the PORT environment variable.';
    fixCommand = process.platform === 'win32' ? 'taskkill /F /IM python.exe /IM node.exe' : 'pkill -f node';
  } else if (logExcerpt.includes('ENOENT') || logExcerpt.includes('file not found')) {
    errorTitle = 'File or Directory Not Found';
    rootCause = 'A referenced script file or path does not exist in the working directory.';
    solution = 'Verify that the entry point file exists and the path is spelled correctly.';
  } else if (logExcerpt.includes('SyntaxError')) {
    errorTitle = 'Syntax Error in Source Code';
    rootCause = 'The code contains a syntax violation or invalid grammar.';
    solution = 'Inspect the line number mentioned in the traceback and fix the code syntax.';
  }

  return {
    errorTitle,
    rootCause,
    solution,
    fixCommand
  };
}

module.exports = { aiAnalyzeRepository, runFallbackAnalysis, aiSolveError };
