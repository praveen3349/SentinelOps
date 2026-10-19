const fs = require('fs');
const path = require('path');

/**
 * Reads a file safely, returns '' if it doesn't exist or can't be read.
 */
function readSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return '';
  }
}

function exists(dir, file) {
  return fs.existsSync(path.join(dir, file));
}

/**
 * Detects the project type/stack of a folder by looking for
 * well-known marker files, similar to how most CI systems auto-detect stacks.
 * Returns { type, framework, buildTool, details[], suggestedCI }
 */
function detectProject(rootPath) {
  const details = [];
  let type = 'Unknown';
  let framework = null;
  let buildTool = null;
  let suggestedCI = [];

  // ---------- Node.js / JavaScript / TypeScript ecosystem ----------
  if (exists(rootPath, 'package.json')) {
    const pkgRaw = readSafe(path.join(rootPath, 'package.json'));
    let pkg = {};
    try { pkg = JSON.parse(pkgRaw); } catch (e) { /* ignore malformed */ }

    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    const depNames = Object.keys(deps);

    type = 'Node.js';
    details.push('Found package.json');

    if (depNames.includes('react') || depNames.includes('react-dom')) {
      framework = 'React';
      if (depNames.includes('next')) framework = 'Next.js';
    } else if (depNames.includes('vue')) {
      framework = 'Vue.js';
      if (depNames.includes('nuxt')) framework = 'Nuxt.js';
    } else if (depNames.includes('@angular/core')) {
      framework = 'Angular';
    } else if (depNames.includes('express') || depNames.includes('fastify') || depNames.includes('koa')) {
      framework = 'Node.js Backend (Express/Fastify/Koa)';
    } else if (depNames.includes('svelte')) {
      framework = 'Svelte';
    }

    if (exists(rootPath, 'yarn.lock')) buildTool = 'Yarn';
    else if (exists(rootPath, 'pnpm-lock.yaml')) buildTool = 'pnpm';
    else if (exists(rootPath, 'package-lock.json')) buildTool = 'npm';
    else buildTool = 'npm (no lockfile found)';

    if (exists(rootPath, 'tsconfig.json')) {
      details.push('TypeScript project (tsconfig.json found)');
    }

    suggestedCI = [
      `${buildTool} install`,
      pkg.scripts && pkg.scripts.build ? `${buildTool === 'Yarn' ? 'yarn' : 'npm run'} build` : null,
      pkg.scripts && pkg.scripts.test ? `${buildTool === 'Yarn' ? 'yarn' : 'npm run'} test` : null
    ].filter(Boolean);
  }

  // ---------- Python ecosystem ----------
  if (
    exists(rootPath, 'requirements.txt') ||
    exists(rootPath, 'pyproject.toml') ||
    exists(rootPath, 'setup.py') ||
    exists(rootPath, 'Pipfile')
  ) {
    type = 'Python';
    details.push('Found Python project marker file(s)');

    if (exists(rootPath, 'manage.py')) {
      framework = 'Django';
    } else if (exists(rootPath, 'app.py') || exists(rootPath, 'main.py')) {
      const appContent = readSafe(path.join(rootPath, 'app.py')) + readSafe(path.join(rootPath, 'main.py'));
      if (appContent.includes('Flask')) framework = 'Flask';
      else if (appContent.includes('FastAPI')) framework = 'FastAPI';
    }

    if (exists(rootPath, 'poetry.lock')) buildTool = 'Poetry';
    else if (exists(rootPath, 'Pipfile.lock')) buildTool = 'Pipenv';
    else buildTool = 'pip';

    suggestedCI = [
      buildTool === 'Poetry' ? 'poetry install' : (buildTool === 'Pipenv' ? 'pipenv install' : 'pip install -r requirements.txt'),
      exists(rootPath, 'pytest.ini') || exists(rootPath, 'tests') ? 'pytest' : null
    ].filter(Boolean);
  }

  // ---------- Java ----------
  if (exists(rootPath, 'pom.xml')) {
    type = 'Java';
    framework = 'Maven project';
    buildTool = 'Maven';
    details.push('Found pom.xml');
    suggestedCI = ['mvn clean install', 'mvn test'];
  } else if (exists(rootPath, 'build.gradle') || exists(rootPath, 'build.gradle.kts')) {
    type = 'Java/Kotlin';
    framework = 'Gradle project';
    buildTool = 'Gradle';
    details.push('Found build.gradle');
    suggestedCI = ['./gradlew build', './gradlew test'];
  }

  // ---------- Go ----------
  if (exists(rootPath, 'go.mod')) {
    type = 'Go';
    buildTool = 'go modules';
    details.push('Found go.mod');
    suggestedCI = ['go build ./...', 'go test ./...'];
  }

  // ---------- Rust ----------
  if (exists(rootPath, 'Cargo.toml')) {
    type = 'Rust';
    buildTool = 'Cargo';
    details.push('Found Cargo.toml');
    suggestedCI = ['cargo build --release', 'cargo test'];
  }

  // ---------- Ruby ----------
  if (exists(rootPath, 'Gemfile')) {
    type = 'Ruby';
    buildTool = 'Bundler';
    details.push('Found Gemfile');
    if (exists(rootPath, 'config/application.rb')) framework = 'Ruby on Rails';
    suggestedCI = ['bundle install', 'bundle exec rspec'];
  }

  // ---------- PHP ----------
  if (exists(rootPath, 'composer.json')) {
    type = 'PHP';
    buildTool = 'Composer';
    details.push('Found composer.json');
    suggestedCI = ['composer install', 'phpunit'];
  }

  // ---------- Docker ----------
  if (exists(rootPath, 'Dockerfile')) {
    details.push('Dockerfile found — project is containerized');
    suggestedCI.push('docker build .');
  }
  if (exists(rootPath, 'docker-compose.yml') || exists(rootPath, 'docker-compose.yaml')) {
    details.push('docker-compose found');
  }

  if (type === 'Unknown') {
    details.push('No recognizable project marker files found in the repo root.');
  }

  return { type, framework, buildTool, details, suggestedCI };
}

module.exports = { detectProject };
