import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const GITLAB_BASE_URL = 'http://10.197.236.185:9001';
const USERNAME = process.env.GITLAB_USERNAME || '';
const PASSWORD = process.env.GITLAB_PASSWORD || '';
if (!USERNAME || !PASSWORD) {
  console.error('缺少 GITLAB_USERNAME / GITLAB_PASSWORD 环境变量，请在项目根目录 .env 中配置');
  process.exit(1);
}
const TARGET_DIR = 'D:\\skt_project';

async function getAccessToken() {
  const resp = await fetch(`${GITLAB_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      username: USERNAME,
      password: PASSWORD,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Failed to get OAuth token: ${resp.status}`);
  }
  const data = await resp.json();
  return data.access_token;
}

async function getAllProjects(token) {
  const allProjects = [];
  let page = 1;
  while (true) {
    const url = `${GITLAB_BASE_URL}/api/v4/projects?per_page=100&page=${page}&membership=true`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      throw new Error(`Failed to fetch projects page ${page}: ${resp.status}`);
    }
    const projects = await resp.json();
    if (!Array.isArray(projects) || projects.length === 0) {
      break;
    }
    allProjects.push(...projects);
    const totalPages = parseInt(resp.headers.get('x-total-pages') || '1', 10);
    if (page >= totalPages) {
      break;
    }
    page++;
  }
  return allProjects;
}

async function syncAll() {
  console.log(`[1/3] 获取 GitLab 访问令牌...`);
  const token = await getAccessToken();
  console.log(`[2/3] 查询账号 [${USERNAME}] 可访问的所有项目...`);
  const projects = await getAllProjects(token);
  console.log(`共发现 ${projects.length} 个项目:`);

  if (!fs.existsSync(TARGET_DIR)) {
    fs.mkdirSync(TARGET_DIR, { recursive: true });
  }

  console.log(`\n[3/3] 开始批量克隆/同步到 ${TARGET_DIR} ...`);
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    const projectPathWithNamespace = p.path_with_namespace; // e.g. "group/project"
    const localProjectPath = path.join(TARGET_DIR, projectPathWithNamespace.replace(/\//g, path.sep));
    
    // Construct authenticated clone URL
    let httpUrl = p.http_url_to_repo;
    const urlObj = new URL(httpUrl);
    urlObj.username = encodeURIComponent(USERNAME);
    urlObj.password = encodeURIComponent(PASSWORD);
    const authCloneUrl = urlObj.toString();

    console.log(`\n[${i + 1}/${projects.length}] 同步项目: ${p.name} (${projectPathWithNamespace})`);

    try {
      if (fs.existsSync(path.join(localProjectPath, '.git'))) {
        console.log(`   - 仓库已存在，执行 git pull --ff-only ...`);
        execSync(`git pull --ff-only`, {
          cwd: localProjectPath,
          stdio: 'pipe',
          timeout: 60000,
        });
        console.log(`   ✅ 更新成功`);
      } else {
        const parentDir = path.dirname(localProjectPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        console.log(`   - 执行 git clone 到 ${localProjectPath} ...`);
        execSync(`git clone --depth 1 "${authCloneUrl}" "${localProjectPath}"`, {
          stdio: 'pipe',
          timeout: 120000,
        });
        console.log(`   ✅ 克隆成功`);
      }
      successCount++;
    } catch (err) {
      console.log(`   ❌ 同步失败: ${err.message}`);
      failCount++;
    }
  }

  console.log(`\n======================================================`);
  console.log(`🎉 同步完成！成功: ${successCount} 个, 失败: ${failCount} 个`);
  console.log(`项目根目录: ${TARGET_DIR}`);
  console.log(`======================================================`);
}

syncAll().catch((err) => {
  console.error('Fatal sync error:', err);
  process.exit(1);
});
