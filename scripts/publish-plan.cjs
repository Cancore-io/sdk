const { execFileSync } = require('node:child_process');
const { readFileSync, appendFileSync } = require('node:fs');
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

module.exports = { releaseOrder, checkDependencies };

if (require.main === module) {
  const { readdirSync, existsSync } = require('node:fs');
  const manifests = new Map();
  for (const dir of readdirSync('packages')) {
    const path = join('packages', dir, 'package.json');
    if (!existsSync(path)) continue;
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    manifests.set(pkg.name, pkg);
  }
  for (const item of releaseOrder(JSON.parse(process.env.PUBLISH_PLAN), manifests)) {
    try {
      checkDependencies(manifests.get(item.name), manifests, (spec) =>
        JSON.parse(execFileSync('npm', ['view', spec, 'version', '--json'], { encoding: 'utf8' })));
      execFileSync('pnpm', ['publish', '--access', 'public', '--tag', item.distTag, '--no-git-checks'],
        { cwd: join('packages', item.dir), stdio: 'inherit' });
      if (process.env.GITHUB_REF_TYPE === 'branch') {
        const tag = item.dir + '-v' + item.version;
        const existing = execFileSync('git', ['ls-remote', '--tags', 'origin', 'refs/tags/' + tag], { encoding: 'utf8' });
        if (!existing.trim()) {
          execFileSync('git', ['tag', tag, process.env.GITHUB_SHA]);
          execFileSync('git', ['push', 'origin', 'refs/tags/' + tag], { stdio: 'inherit' });
        }
      }
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, '- Published ' + item.name + '@' + item.version + '\n');
    } catch (error) {
      console.error(item.name + ': ' + error.message);
      process.exitCode = 1;
    }
  }
}
