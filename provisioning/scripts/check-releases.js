const https = require('https');

function get(url, cb) {
  const u = new URL(url);
  const pat = process.env.GITOPS_PAT || '';
  const headers = {
    'User-Agent': 'debug',
    'Accept': 'application/vnd.github.v3+json',
  };
  if (pat) headers['Authorization'] = 'Bearer ' + pat;

  https.get({ hostname: u.hostname, path: u.pathname + u.search, headers }, (r) => {
    if (r.statusCode === 301 || r.statusCode === 302) {
      get(r.headers.location, cb);
      return;
    }
    let d = '';
    r.on('data', (c) => (d += c));
    r.on('end', () => cb(r.statusCode, d));
  });
}

const deployableTagPattern = /^v\d+\.\d+\.\d+$/;

function isDeployable(name) {
  if (!name) return false;
  if (name.toLowerCase().startsWith('provisioning-')) return false;
  return deployableTagPattern.test(name);
}

function compareSemver(a, b) {
  const parse = (v) => v.replace(/^v/, '').split('.').map(Number);
  const [aMajor, aMinor, aPatch] = parse(a);
  const [bMajor, bMinor, bPatch] = parse(b);
  return bMajor - aMajor || bMinor - aMinor || bPatch - aPatch;
}

async function fetchAllTags() {
  const allDeployable = [];
  for (let page = 1; page <= 3; page++) {
    const tags = await new Promise((resolve, reject) => {
      get(
        `https://api.github.com/repos/Iotistica/iotistic/tags?per_page=100&page=${page}`,
        (code, body) => {
          try {
            const parsed = JSON.parse(body);
            if (!Array.isArray(parsed)) {
              reject(new Error(`Page ${page}: STATUS ${code} - ${JSON.stringify(parsed).slice(0, 200)}`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(e);
          }
        }
      );
    });
    console.log(`Page ${page}: ${tags.length} tags`);
    const deployable = tags.filter((t) => isDeployable(t.name));
    allDeployable.push(...deployable);
    if (tags.length < 100) break; // last page
  }
  return allDeployable;
}

async function fetchAllTags() {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const tags = await new Promise((resolve, reject) => {
      get(
        `https://api.github.com/repos/Iotistica/iotistic/tags?per_page=100&page=${page}`,
        (code, body) => {
          try {
            const parsed = JSON.parse(body);
            if (!Array.isArray(parsed)) reject(new Error(`${code}: ${JSON.stringify(parsed).slice(0, 200)}`));
            else resolve(parsed);
          } catch (e) { reject(e); }
        }
      );
    });
    console.log(`Page ${page}: ${tags.length} tags`);
    all.push(...tags);
    if (tags.length < 100) break;
  }
  return all;
}

fetchAllTags()
  .then((all) => {
    console.log(`\nTotal tags: ${all.length}`);
    const v1finals = all.filter((t) => /^v1\.\d+\.\d+$/.test(t.name));
    const v0finals = all.filter((t) => /^v0\.\d+\.\d+$/.test(t.name));
    console.log(`v1.x.x finals: ${v1finals.length}`, v1finals.slice(0, 5).map((t) => t.name));
    console.log(`v0.x.x finals: ${v0finals.length}`, v0finals.slice(0, 5).map((t) => t.name));
    const deployable = all.filter((t) => isDeployable(t.name));
    deployable.sort((a, b) => compareSemver(a.name, b.name));
    console.log(`\nDeployable: ${deployable.length}, would deploy: ${deployable[0]?.name ?? 'NONE'}`);
  })
  .catch(console.error);
