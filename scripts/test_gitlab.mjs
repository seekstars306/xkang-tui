import 'dotenv/config';
import fs from 'node:fs';

const GITLAB_BASE_URL = 'http://10.197.236.185:9001';
const USERNAME = process.env.GITLAB_USERNAME || '';
const PASSWORD = process.env.GITLAB_PASSWORD || '';
if (!USERNAME || !PASSWORD) {
  console.error('缺少 GITLAB_USERNAME / GITLAB_PASSWORD 环境变量，请在项目根目录 .env 中配置');
  process.exit(1);
}

async function testGitlabAuth() {
  console.log(`Connecting to GitLab at ${GITLAB_BASE_URL}...`);
  
  // 1. Try OAuth token endpoint (Resource Owner Password Credentials)
  try {
    const tokenResp = await fetch(`${GITLAB_BASE_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        username: USERNAME,
        password: PASSWORD,
      }),
    });
    
    console.log(`OAuth token status: ${tokenResp.status}`);
    if (tokenResp.ok) {
      const data = await tokenResp.json();
      console.log('OAuth token obtained successfully:', data.access_token ? 'YES' : 'NO');
      return data.access_token;
    } else {
      const txt = await tokenResp.text();
      console.log('OAuth token error response:', txt);
    }
  } catch (err) {
    console.log('OAuth token fetch exception:', err.message);
  }

  // 2. Try session / basic auth API
  try {
    const basicAuth = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
    const resp = await fetch(`${GITLAB_BASE_URL}/api/v4/projects?per_page=50`, {
      headers: {
        Authorization: `Basic ${basicAuth}`,
      },
    });
    console.log(`Basic auth projects endpoint status: ${resp.status}`);
    if (resp.ok) {
      const projects = await resp.json();
      console.log(`Found ${projects.length} projects with Basic Auth!`);
      return { type: 'basic', basicAuth, projects };
    }
  } catch (err) {
    console.log('Basic auth exception:', err.message);
  }

  // 3. Try web login cookie flow
  try {
    console.log('Attempting web login flow...');
    const signinPageResp = await fetch(`${GITLAB_BASE_URL}/users/sign_in`);
    const setCookie = signinPageResp.headers.get('set-cookie');
    const html = await signinPageResp.text();
    
    // Extract authenticity_token
    const tokenMatch = html.match(/name="authenticity_token"\s+value="([^"]+)"/);
    const csrfToken = tokenMatch ? tokenMatch[1] : null;
    console.log('CSRF Token found:', csrfToken ? 'YES' : 'NO');
    
    if (csrfToken && setCookie) {
      const cookie = setCookie.split(';')[0];
      const formData = new URLSearchParams();
      formData.append('user[login]', USERNAME);
      formData.append('user[password]', PASSWORD);
      formData.append('authenticity_token', csrfToken);
      
      const loginResp = await fetch(`${GITLAB_BASE_URL}/users/sign_in`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookie,
        },
        body: formData.toString(),
        redirect: 'manual',
      });
      
      console.log('Login POST status:', loginResp.status);
      const loginCookie = loginResp.headers.get('set-cookie');
      console.log('Login cookie received:', loginCookie ? 'YES' : 'NO');
    }
  } catch (err) {
    console.log('Web login exception:', err.message);
  }
}

testGitlabAuth();
