const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const port = 3000;

// --- 配置区 ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; 
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '888888';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ==========================================
// 🚀 内存缓存管理 (含频率限制)
// ==========================================
const LocalCache = {
    records: [],
    aliases: {},
    subAdminPwd: null, 
    
    // 🔥 v9.01: 记录子管理员最后一次提交的时间戳
    lastSubActionTime: 0, 

    async sync(forceRefresh = false) {
        if (this.records.length > 0 && !forceRefresh) return;

        console.log(`[CACHE] ${forceRefresh ? '♻️ Refreshing...' : '📥 Initializing...'}`);
        
        const [recordsRes, aliasesRes, subPwdRes] = await Promise.all([
            supabase.from('records').select('*').order('play_date', { ascending: false }),
            supabase.from('settings').select('value').eq('key', 'mahjong_aliases').single(),
            supabase.from('settings').select('value').eq('key', 'sub_admin_password').single()
        ]);

        if (recordsRes.error) console.error("Records fetch failed", recordsRes.error);
        
        this.records = recordsRes.data || [];
        this.aliases = aliasesRes.data ? aliasesRes.data.value : {};
        this.subAdminPwd = subPwdRes.data ? subPwdRes.data.value : null;

        console.log(`[CACHE] ✅ Loaded. Records: ${this.records.length}, SubAdminPwd: ${this.subAdminPwd ? 'SET' : 'NOT SET'}`);
    }
};

// ==========================================
// 🛡️ 权限验证中间件
// ==========================================
const authMiddleware = (req, res, next) => {
    const token = req.headers['x-admin-token'];
    
    if (token === ADMIN_PASSWORD) {
        req.userRole = 'admin';
        return next();
    }
    
    if (LocalCache.subAdminPwd && token === LocalCache.subAdminPwd) {
        req.userRole = 'sub_admin';
        return next();
    }

    res.status(401).json({ error: '密码错误或权限不足' });
};

const requireSuperAdmin = (req, res, next) => {
    if (req.userRole === 'admin') {
        next();
    } else {
        res.status(403).json({ error: '权限不足：仅主管理员可执行此操作' });
    }
};

// --- API 0: 登录验证 ---
app.post('/api/login', authMiddleware, (req, res) => {
    res.json({ success: true, role: req.userRole });
});

// --- API: 设置子管理员密码 ---
app.post('/api/settings/sub-password', authMiddleware, requireSuperAdmin, async (req, res) => {
    try {
        const { password } = req.body;
        const { error } = await supabase.from('settings').upsert({
            key: 'sub_admin_password',
            value: password
        });
        if (error) throw error;
        
        await LocalCache.sync(true); 
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- API 1: 获取战绩 ---
app.get('/api/records', async (req, res) => {
    try {
        await LocalCache.sync(false);
        res.json(LocalCache.records);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- API 2: 上传战绩 (🔥 v9.01: 增加频率限制) ---
app.post('/api/records', authMiddleware, async (req, res) => {
    // 🛑 频率限制逻辑 (仅针对 sub_admin)
    if (req.userRole === 'sub_admin') {
        const now = Date.now();
        const COOLDOWN = 10 * 60 * 1000; // 10分钟
        const timeDiff = now - LocalCache.lastSubActionTime;

        if (timeDiff < COOLDOWN) {
            const remainingMin = Math.ceil((COOLDOWN - timeDiff) / 60000);
            return res.status(429).json({
                error: `录入太频繁！请等待 ${remainingMin} 分钟后再试。`
            });
        }
    }

    try {
        // 支持批量导入（数组）或单条导入（对象）
        const data = Array.isArray(req.body) ? req.body : [req.body];
        const { error } = await supabase.from('records').insert(data);
        if (error) {
            if (error.code === '23505') return res.status(409).json({ error: '重复数据' });
            throw error;
        }

        // ✅ 提交成功，记录时间并刷新缓存
        if (req.userRole === 'sub_admin') {
            LocalCache.lastSubActionTime = Date.now();
        }
        await LocalCache.sync(true);

        res.json({ success: true, imported: data.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 批量导入API（仅主管理员可用）
app.post('/api/records/batch', authMiddleware, requireSuperAdmin, async (req, res) => {
    try {
        const { records } = req.body;
        if (!Array.isArray(records) || records.length === 0) {
            return res.status(400).json({ error: '无效的数据格式' });
        }

        const { error } = await supabase.from('records').insert(records);
        if (error) {
            if (error.code === '23505') return res.status(409).json({ error: '部分数据重复' });
            throw error;
        }

        await LocalCache.sync(true);
        res.json({ success: true, imported: records.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- API 3: 获取别名 ---
app.get('/api/aliases', async (req, res) => {
    try {
        await LocalCache.sync(false);
        res.json(LocalCache.aliases);
    } catch (e) { res.json({}); }
});

// --- API 4: 保存别名 ---
app.post('/api/aliases', authMiddleware, requireSuperAdmin, async (req, res) => {
    try {
        const { error } = await supabase.from('settings').upsert({
            key: 'mahjong_aliases',
            value: req.body
        });
        if (error) throw error;
        await LocalCache.sync(true);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- API 5: 删除战绩 ---
app.delete('/api/records/:id', authMiddleware, requireSuperAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase.from('records').delete().eq('id', id);
        if (error) throw error;
        await LocalCache.sync(true);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- API 6: 修改战绩 ---
app.put('/api/records/:id', authMiddleware, requireSuperAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        delete updates.id;

        let { data, error } = await supabase.from('records').update(updates).eq('id', id).select();
        
        if (!data || data.length === 0) {
            if (/^\d+$/.test(id)) {
                const retry = await supabase.from('records').update(updates).eq('id', parseInt(id)).select();
                data = retry.data;
                error = retry.error;
            }
        }

        if (error) throw error;
        if (!data || data.length === 0) return res.status(404).json({ error: '找不到该战绩' });

        await LocalCache.sync(true);
        res.json({ success: true, record: data[0] });

    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    LocalCache.sync(true).catch(e => console.error("Init Cache Failed:", e));
});