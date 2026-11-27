const { execFileSync } = require('node:child_process');
const { readFileSync, appendFileSync, readdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');

function workspaceRanges(manifest, manifests) {
  const all = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
  return Object.entries(all).filter(([name]) => name.startsWith('@cancore/')).map(([name, spec]) => {
    const range = spec.replace(/^workspace:/, '');
    if (spec.startsWith('workspace:') && ['*', '^', '~'].includes(range)) {
      const version = manifests.get(name).version;
      return [name, range === '*' ? version : range + version];
    }
    return [name, range];
  });
}

function releaseOrder(plan, manifests) {
  const ordered = [];
  const pending = new Map(plan.map((item) => [item.name, item]));
  while (pending.size) {
    const next = [...pending.values()].find(({ name }) =>
      workspaceRanges(manifests.get(name), manifests).every(([dep]) => !pending.has(dep)));
    if (!next) throw new Error('Circular workspace release dependencies');
    pending.delete(next.name);
    ordered.push(next);
  }
  return ordered;
}

function checkDependencies(pkg, manifests, view) {
  for (const [name, range] of workspaceRanges(pkg, manifests)) {
    const result = view(name + '@' + range);
    if (!(Array.isArray(result) ? result.length : typeof result === 'string' && result.length)) {
      throw new Error('No published version satisfies ' + name + '@' + range);
    }
  }
}

function readManifests() {
  const manifests = new Map();
  for (const dir of readdirSync('packages')) {
    const path = join('packages', dir, 'package.json');
    if (!existsSync(path)) continue;
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    manifests.set(pkg.name, pkg);
  }
  return manifests;
}

function publishPackages(plan, manifests, env, exec = execFileSync) {
  let exitCode = 0;
  for (const item of releaseOrder(plan, manifests)) {
    try {
      checkDependencies(manifests.get(item.name), manifests, (spec) =>
        JSON.parse(exec('npm', ['view', spec, 'version', '--json'], { encoding: 'utf8' })));
      exec('pnpm', ['publish', '--access', 'public', '--tag', item.distTag, '--no-git-checks'],
        { cwd: join('packages', item.dir), stdio: 'inherit' });
      if (env.GITHUB_REF_TYPE === 'branch') {
        const tag = item.dir + '-v' + item.version;
        const existing = exec('git', ['ls-remote', '--tags', 'origin', 'refs/tags/' + tag], { encoding: 'utf8' });
        if (!existing.trim()) {
          exec('git', ['tag', tag, env.GITHUB_SHA]);
          exec('git', ['push', 'origin', 'refs/tags/' + tag], { stdio: 'inherit' });
        }
      }
      appendFileSync(env.GITHUB_STEP_SUMMARY, '- Published ' + item.name + '@' + item.version + '\n');
    } catch (error) {
      console.error(item.name + ': ' + error.message);
      exitCode = 1;
    }
  }
  return exitCode;
}

module.exports = { releaseOrder, checkDependencies, publishPackages };

if (require.main === module) {
  process.exitCode = publishPackages(JSON.parse(process.env.PUBLISH_PLAN), readManifests(), process.env);
}
