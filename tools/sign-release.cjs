// 릴리스 서명 (개발자 PC에서만 실행). 앱은 이 서명이 맞는 업데이트만 조용히 설치한다 (electron/update.cjs).
//   한 번만: node tools/sign-release.cjs init            개인 키(비밀번호로 잠금)를 만들고 공개 키를 electron/release-key.pub.pem에 쓴다
//   릴리스마다: node tools/sign-release.cjs v1.3.1        Actions가 초안으로 올린 .sha256에 서명해 .sig를 올리고 릴리스를 공개한다
// 개인 키 기본 위치: ~/.aas-release/release-key.pem (--key <경로>로 바꿈). 저장소에 넣지 말고 USB 등에 따로 백업한다.
// 키를 잃으면 그 뒤 버전은 자동 업데이트가 안 된다 (사용자가 직접 받아 설치해야 함).
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');

const PUB = path.join(__dirname, '..', 'electron', 'release-key.pub.pem');
const DEFAULT_KEY = path.join(os.homedir(), '.aas-release', 'release-key.pem');

/** ed25519 키 한 쌍. 개인 키는 비밀번호로 암호화한 PEM */
function makeKeys(passphrase) {
  return crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
  });
}
/** .sha256 파일 바이트에 대한 서명 (base64 한 줄) */
const sign = (sumBuf, privatePem, passphrase) => crypto.sign(null, sumBuf, crypto.createPrivateKey({ key: privatePem, passphrase })).toString('base64');

/** 입력을 화면에 보이지 않게 받는다 (비밀번호) */
function ask(q, hidden = false) {
  return new Promise((ok) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); ok(a); });
    // 질문을 쓴 뒤부터 치는 글자를 보여 주지 않음
    if (hidden) rl._writeToOutput = () => {};
  });
}
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' });

async function init(keyFile) {
  if (fs.existsSync(keyFile)) throw new Error(`이미 개인 키가 있습니다: ${keyFile} (새로 만들면 이전 버전 앱이 새 서명을 못 믿습니다)`);
  const p1 = await ask('개인 키 비밀번호: ', true), p2 = await ask('한 번 더: ', true);
  if (p1 !== p2) throw new Error('비밀번호가 서로 다릅니다');
  if (p1.length < 12) throw new Error('비밀번호는 12자 이상으로 해 주세요');
  const { publicKey, privateKey } = makeKeys(p1);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, privateKey, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(PUB, publicKey);
  console.log(`개인 키: ${keyFile}\n공개 키: ${PUB} (이 파일은 커밋합니다)\n개인 키 파일과 비밀번호를 따로 백업하세요.`);
}

async function release(tag, keyFile) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`태그 형식이 아닙니다: ${tag}`);
  const info = JSON.parse(gh('release', 'view', tag, '--json', 'isDraft,assets,databaseId'));
  const name = `App-Architect-Studio-Setup-${tag.slice(1)}.exe.sha256`;
  if (!info.assets.some((a) => a.name === name)) throw new Error(`${tag} 릴리스에 ${name}이 아직 없습니다 (Actions가 끝났는지 확인)`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aas-sign-'));
  try {
    gh('release', 'download', tag, '-p', name, '-D', dir);
    const sumBuf = fs.readFileSync(path.join(dir, name));
    console.log(`서명할 지문: ${sumBuf.toString('utf8').trim()}`);
    if ((await ask('이 지문에 서명하고 릴리스를 공개할까요? (y/N) ')).trim().toLowerCase() !== 'y') return console.log('그만둠');
    const sig = sign(sumBuf, fs.readFileSync(keyFile, 'utf8'), await ask('개인 키 비밀번호: ', true));
    // 저장소의 공개 키(앱에 들어가는 키)로 확인되는지 — 다른 키로 서명해 올리는 실수를 막음
    if (!crypto.verify(null, sumBuf, fs.readFileSync(PUB, 'utf8'), Buffer.from(sig, 'base64'))) throw new Error('이 개인 키가 electron/release-key.pub.pem과 짝이 아닙니다');
    const sigFile = path.join(dir, `${name}.sig`);
    fs.writeFileSync(sigFile, `${sig}\n`);
    gh('release', 'upload', tag, sigFile, '--clobber');
    if (info.isDraft) gh('release', 'edit', tag, '--draft=false');
    // make_latest=legacy: "최신" 표시는 날짜·버전 번호로 (release.yml과 같게)
    gh('api', '-X', 'PATCH', `repos/{owner}/{repo}/releases/${info.databaseId}`, '-f', 'make_latest=legacy');
    console.log(`${tag}: 서명을 올리고 공개했습니다`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const k = rest.indexOf('--key'), keyFile = k >= 0 ? path.resolve(rest[k + 1]) : DEFAULT_KEY;
  (cmd === 'init' ? init(keyFile) : cmd ? release(cmd, keyFile) : Promise.reject(new Error('사용법: node tools/sign-release.cjs init | v<버전> [--key <개인 키 경로>]')))
    .catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { makeKeys, sign };
