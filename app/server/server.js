const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execSync, exec, spawn } = require('child_process');

const app = express();
const PORT = 18900;

// 配置路径
const CONFIG_DIR = '/tmp/fn-google-drive/config';
const RCLONE_CONFIG = `${CONFIG_DIR}/rclone.conf`;
const PROXY_CONFIG = `${CONFIG_DIR}/proxy.json`;
const MOUNT_POINT = '/vol1/GoogleDrive';
const MOUNT_INFO = '/etc/mountmgr/mount_info.json';
const PID_FILE = `${CONFIG_DIR}/mount.pid`;
const LOG_FILE = `${CONFIG_DIR}/mount.log`;

// 确保配置目录存在
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../www')));

// ============ 配置管理 ============

function getRcloneConfig() {
  if (fs.existsSync(RCLONE_CONFIG)) {
    return fs.readFileSync(RCLONE_CONFIG, 'utf8');
  }
  return '';
}

function saveRcloneConfig(config) {
  fs.writeFileSync(RCLONE_CONFIG, config);
}

function getProxyConfig() {
  if (fs.existsSync(PROXY_CONFIG)) {
    return JSON.parse(fs.readFileSync(PROXY_CONFIG, 'utf8'));
  }
  return { enabled: false, type: 'http', host: '', port: '', username: '', password: '' };
}

function saveProxyConfig(config) {
  fs.writeFileSync(PROXY_CONFIG, JSON.stringify(config, null, 2));
}

// ============ rclone 操作 ============

function isRcloneInstalled() {
  try {
    execSync('rclone version', { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch (error) {
    return false;
  }
}

function isGdriveConfigured() {
  try {
    const result = execSync(`rclone listremotes --config ${RCLONE_CONFIG} 2>/dev/null`, { encoding: 'utf8' });
    return result.includes('gdrive:');
  } catch (error) {
    return false;
  }
}

function isMounted() {
  try {
    // 检查挂载点是否有进程
    if (fs.existsSync(PID_FILE)) {
      const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
      // 检查进程是否存在
      try {
        execSync(`kill -0 ${pid}`, { encoding: 'utf8' });
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  } catch (error) {
    return false;
  }
}

// 获取代理环境变量
function getProxyEnv() {
  const proxyConfig = getProxyConfig();
  const env = { ...process.env };
  
  if (proxyConfig.enabled && proxyConfig.host) {
    let proxyUrl;
    if (proxyConfig.username) {
      proxyUrl = `${proxyConfig.type}://${proxyConfig.username}:${proxyConfig.password}@${proxyConfig.host}:${proxyConfig.port}`;
    } else {
      proxyUrl = `${proxyConfig.type}://${proxyConfig.host}:${proxyConfig.port}`;
    }
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.ALL_PROXY = proxyUrl;
  }
  
  return env;
}

// 启动挂载
function startMount() {
  // 确保挂载点存在
  if (!fs.existsSync(MOUNT_POINT)) {
    fs.mkdirSync(MOUNT_POINT, { recursive: true });
  }
  
  // 构建挂载命令
  const proxyConfig = getProxyConfig();
  let proxyArgs = '';
  
  if (proxyConfig.enabled && proxyConfig.host) {
    let proxyUrl;
    if (proxyConfig.username) {
      proxyUrl = `${proxyConfig.type}://${proxyConfig.username}:${proxyConfig.password}@${proxyConfig.host}:${proxyConfig.port}`;
    } else {
      proxyUrl = `${proxyConfig.type}://${proxyConfig.host}:${proxyConfig.port}`;
    }
    proxyArgs = `--drive-use-created-date=false`;
  }
  
  // 使用rclone mount挂载
  const cmd = `rclone mount gdrive: ${MOUNT_POINT} \\
    --config ${RCLONE_CONFIG} \\
    --allow-other \\
    --allow-non-empty \\
    --vfs-cache-mode writes \\
    --vfs-cache-max-age 100h \\
    --vfs-read-ahead 128M \\
    --buffer-size 64M \\
    --dir-cache-time 72h \\
    --poll-interval 15s \\
    --log-file ${LOG_FILE} \\
    --log-level INFO \\
    ${proxyArgs} &
  
  echo $! > ${PID_FILE}`;
  
  const env = getProxyEnv();
  exec(cmd, { env });
  
  // 添加到飞牛挂载
  addToFnosMount();
}

// 停止挂载
function stopMount() {
  try {
    // 停止rclone进程
    execSync(`fusermount -u ${MOUNT_POINT} 2>/dev/null || umount ${MOUNT_POINT} 2>/dev/null || true`);
    
    if (fs.existsSync(PID_FILE)) {
      const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
      try {
        execSync(`kill ${pid}`);
      } catch (e) {
        // 忽略
      }
      fs.unlinkSync(PID_FILE);
    }
    
    // 清理飞牛挂载配置
    removeFromFnosMount();
    
    return true;
  } catch (error) {
    console.error('停止挂载失败:', error.message);
    return false;
  }
}

// ============ 飞牛集成 ============

function addToFnosMount() {
  try {
    let mountInfo = [];
    if (fs.existsSync(MOUNT_INFO)) {
      try {
        mountInfo = JSON.parse(fs.readFileSync(MOUNT_INFO, 'utf8'));
      } catch (e) {
        mountInfo = [];
      }
    }
    
    // 检查是否已存在
    const exists = mountInfo.some(m => m.name === 'Google Drive' || m.mountPoint === MOUNT_POINT);
    if (!exists) {
      mountInfo.push({
        name: 'Google Drive',
        type: 'local',
        mountPoint: MOUNT_POINT,
        source: 'fn-google-drive',
        autoMount: true,
        readOnly: false
      });
      fs.writeFileSync(MOUNT_INFO, JSON.stringify(mountInfo, null, 2));
    }
    
    return true;
  } catch (error) {
    console.error('添加到飞牛挂载失败:', error.message);
    return false;
  }
}

function removeFromFnosMount() {
  try {
    if (fs.existsSync(MOUNT_INFO)) {
      let mountInfo = JSON.parse(fs.readFileSync(MOUNT_INFO, 'utf8'));
      mountInfo = mountInfo.filter(m => m.source !== 'fn-google-drive');
      fs.writeFileSync(MOUNT_INFO, JSON.stringify(mountInfo, null, 2));
    }
    return true;
  } catch (error) {
    console.error('从飞牛挂载移除失败:', error.message);
    return false;
  }
}

// ============ 容量查询 ============

// 通过rclone获取容量
function getCapacityViaRclone() {
  try {
    const result = execSync(`rclone about gdrive: --json --config ${RCLONE_CONFIG}`, { 
      encoding: 'utf8',
      timeout: 30000,
      env: getProxyEnv()
    });
    return JSON.parse(result);
  } catch (error) {
    console.error('rclone获取容量失败:', error.message);
    return null;
  }
}

// 通过Google Drive API直接获取容量（更实时）
function getCapacityViaAPI() {
  try {
    // 读取rclone配置获取token
    const config = getRcloneConfig();
    const tokenMatch = config.match(/token\s*=\s*({.*})/s);
    if (!tokenMatch) return null;
    
    const token = JSON.parse(tokenMatch[1]);
    
    // 使用curl调用Google Drive API
    const result = execSync(`curl -s -H "Authorization: Bearer ${token.access_token}" "https://www.googleapis.com/drive/v3/about?fields=storageQuota"`, {
      encoding: 'utf8',
      timeout: 15000,
      env: getProxyEnv()
    });
    
    const data = JSON.parse(result);
    if (data.storageQuota) {
      return {
        used: parseInt(data.storageQuota.usage || 0),
        free: parseInt(data.storageQuota.limit || 0) - parseInt(data.storageQuota.usage || 0),
        total: parseInt(data.storageQuota.limit || 0),
        trashed: parseInt(data.storageQuota.usageInDriveTrash || 0)
      };
    }
    return null;
  } catch (error) {
    console.error('API获取容量失败:', error.message);
    return null;
  }
}

// 刷新token（如果过期）
function refreshToken() {
  try {
    const config = getRcloneConfig();
    const tokenMatch = config.match(/token\s*=\s*({.*})/s);
    if (!tokenMatch) return false;
    
    const token = JSON.parse(tokenMatch[1]);
    const clientMatch = config.match(/client_id\s*=\s*(.+)/);
    const secretMatch = config.match(/client_secret\s*=\s*(.+)/);
    
    if (!clientMatch || !secretMatch) return false;
    
    const result = execSync(`curl -s -X POST "https://oauth2.googleapis.com/token" \\
      -d "client_id=${clientMatch[1].trim()}" \\
      -d "client_secret=${secretMatch[1].trim()}" \\
      -d "refresh_token=${token.refresh_token}" \\
      -d "grant_type=refresh_token"`, {
      encoding: 'utf8',
      timeout: 15000,
      env: getProxyEnv()
    });
    
    const newToken = JSON.parse(result);
    if (newToken.access_token) {
      token.access_token = newToken.access_token;
      token.expiry = new Date(Date.now() + newToken.expires_in * 1000).toISOString();
      
      // 更新配置
      const newConfig = config.replace(/token\s*=\s*{.*}/s, `token = ${JSON.stringify(token)}`);
      saveRcloneConfig(newConfig);
      return true;
    }
    return false;
  } catch (error) {
    console.error('刷新token失败:', error.message);
    return false;
  }
}

// ============ API路由 ============

// 获取状态
app.get('/api/status', (req, res) => {
  res.json({
    rcloneInstalled: isRcloneInstalled(),
    gdriveConfigured: isGdriveConfigured(),
    mounted: isMounted(),
    proxyConfig: getProxyConfig(),
    mountPoint: MOUNT_POINT
  });
});

// 获取代理配置
app.get('/api/proxy', (req, res) => {
  res.json(getProxyConfig());
});

// 保存代理配置
app.post('/api/proxy', (req, res) => {
  saveProxyConfig(req.body);
  res.json({ success: true });
});

// 测试代理
app.post('/api/proxy/test', (req, res) => {
  const { type, host, port, username, password } = req.body;
  
  try {
    let proxyUrl;
    if (username) {
      proxyUrl = `${type}://${username}:${password}@${host}:${port}`;
    } else {
      proxyUrl = `${type}://${host}:${port}`;
    }
    
    execSync(`curl -x "${proxyUrl}" -s --connect-timeout 5 "https://www.google.com" -o /dev/null`, { 
      encoding: 'utf8',
      timeout: 10000
    });
    res.json({ success: true, message: '代理连接成功' });
  } catch (error) {
    res.json({ success: false, message: '代理连接失败: ' + error.message });
  }
});

// 获取rclone配置
app.get('/api/rclone-config', (req, res) => {
  res.json({ config: getRcloneConfig() });
});

// 保存rclone配置
app.post('/api/rclone-config', (req, res) => {
  saveRcloneConfig(req.body.config);
  res.json({ success: true });
});

// 启动挂载
app.post('/api/mount/start', (req, res) => {
  try {
    if (!isGdriveConfigured()) {
      return res.json({ success: false, message: '请先配置Google Drive' });
    }
    
    // 先停止现有挂载
    stopMount();
    
    // 启动新挂载
    startMount();
    
    // 等待挂载完成
    setTimeout(() => {
      if (isMounted()) {
        res.json({ success: true, message: '挂载已启动，可在飞牛文件管理器中访问' });
      } else {
        res.json({ success: false, message: '挂载启动失败，请检查日志' });
      }
    }, 2000);
  } catch (error) {
    res.json({ success: false, message: '启动失败: ' + error.message });
  }
});

// 停止挂载
app.post('/api/mount/stop', (req, res) => {
  if (stopMount()) {
    res.json({ success: true, message: '挂载已停止' });
  } else {
    res.json({ success: false, message: '停止失败' });
  }
});

// 获取容量（实时）
app.get('/api/capacity', (req, res) => {
  // 优先使用API获取（更实时）
  let capacity = getCapacityViaAPI();
  
  // 如果API失败，使用rclone
  if (!capacity) {
    capacity = getCapacityViaRclone();
  }
  
  if (capacity) {
    res.json(capacity);
  } else {
    res.json({ error: '无法获取容量信息，请检查配置和网络' });
  }
});

// 刷新容量
app.post('/api/capacity/refresh', (req, res) => {
  // 尝试刷新token
  refreshToken();
  
  // 获取容量
  let capacity = getCapacityViaAPI();
  if (!capacity) {
    capacity = getCapacityViaRclone();
  }
  
  if (capacity) {
    res.json(capacity);
  } else {
    res.json({ error: '无法获取容量信息' });
  }
});

// 获取挂载日志
app.get('/api/logs', (req, res) => {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const logs = fs.readFileSync(LOG_FILE, 'utf8');
      const lines = logs.split('\n').slice(-100); // 最近100行
      res.json({ logs: lines.join('\n') });
    } else {
      res.json({ logs: '暂无日志' });
    }
  } catch (error) {
    res.json({ logs: '读取日志失败' });
  }
});

// 启动服务器
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Google Drive 挂载管理服务运行在 http://0.0.0.0:${PORT}`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  stopMount();
  process.exit(0);
});

process.on('SIGINT', () => {
  stopMount();
  process.exit(0);
});