const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const port = 3000;



// 从环境变量读取敏感信息 (Docker 部署时注入)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // 这里填 SERVICE_ROLE_KEY 或 ANON_KEY
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '888888';

// 初始化 Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(cors());
app.use(express.json());

// 托管 public 目录下的静态文件 (即你的 index.html)
app.use(express.static('public'));

// --- 中间件：验证管理员密码 ---
const authMiddleware = (req, res, next) => {    
    const token = req.headers['x-admin-token'];    
    if (token === ADMIN_PASSWORD) {
        next();        
    } else {        
        res.status(401).json({ error: '密码错误' });        
    }    
};

// --- API 0: 登录验证专用接口 (保留，用于前端校验密码) ---
app.post('/api/login', authMiddleware, (req, res) => {    
    res.json({ success: true, message: "验证通过" });    
});

// --- API 1: 获取战绩 (公开，不需要密码) ---
app.get('/api/records', async (req, res) => {    
    try {        
        const { data, error } = await supabase        
        .from('records')        
        .select('*')        
        .order('play_date', { ascending: false });
        
        if (error) throw error;        
        res.json(data);        
    } catch (e) {        
        res.status(500).json({ error: e.message });
    }
});

// --- API 2: 上传战绩 (需密码) ---
app.post('/api/records', authMiddleware, async (req, res) => {
    try {
        const { error } = await supabase.from('records').insert(req.body);
        if (error) {
            // 唯一性约束错误码
            if (error.code === '23505') return res.status(409).json({ error: '重复数据' });
            throw error;
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- API 3: 获取别名 (公开) ---
app.get('/api/aliases', async (req, res) => {
    try {
        const { data } = await supabase
        .from('settings')
        .select('value')
        .eq('key', 'mahjong_aliases')
        .single();
        res.json(data?.value || {});
    } catch (e) {
        res.json({}); // 查不到就返回空对象
    }
});

// --- API 4: 保存别名 (需密码) ---
app.post('/api/aliases', authMiddleware, async (req, res) => {
    try {
        const { error } = await supabase.from('settings').upsert({
            key: 'mahjong_aliases',
            value: req.body
        });
        if (error) throw error;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- API 5: 删除战绩 (🔐 需密码) ---
// 新增：接收一个 id 参数
app.delete('/api/records/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        // 调用 Supabase 删除指定 ID 的记录
        const { error } = await supabase.from('records').delete().eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- API 6: 修改战绩 (🔐 需密码) ---
// 🆕 新增：接收 id 和新的数据 body，更新指定记录
app.put('/api/records/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        // 防止用户意外修改 id (虽然 supabase通常会忽略，但为了安全起见)
        delete updates.id;
        
        const { data, error } = await supabase
        .from('records')
        .update(updates)
        .eq('id', id)
        .select(); // select() 返回更新后的数据，方便前端确认
        
        if (error) throw error;
        if (data.length === 0) {
            return res.status(404).json({ error: '找不到该战绩或无权修改' });
        }
        res.json({ success: true, record: data[0] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});