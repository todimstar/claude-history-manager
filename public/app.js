const { createApp, ref, reactive, computed, onMounted } = Vue;

const app = createApp({
  setup() {
    // ─── 状态 ─────────────────────────────────────
    const currentView = ref('dashboard');
    const loading = ref(false);
    const projects = ref([]);
    const stats = ref({});
    const sessions = ref([]);
    const selectedSessions = ref([]);
    const sessionFilter = ref('');
    const hideEmpty = ref(true);
    const currentProject = ref('');
    const currentProjectDisplay = ref('');
    const currentSessionId = ref('');
    const detailMessages = ref([]);
    const detailMeta = reactive({ gitBranch: '', version: '' });
    const detailFiles = ref({});
    const globalSearch = ref('');
    const searchKeyword = ref('');
    const searchResults = ref([]);
    const toasts = ref([]);
    const confirmDialog = reactive({
      show: false, title: '', message: '', safetyNote: '',
      btnText: '', btnClass: '', onConfirm: () => {}
    });

    // 回收站
    const trashData = ref({ items: [], totalSize: 0, totalFormatted: '0 B' });
    const trashCount = ref(0);

    // 设置
    const settingsForm = reactive({ cleanupPeriodDays: 30 });
    const settingsSaving = ref(false);
    const settingsFilePath = ref('');

    // 孤立文件列表
    const orphanType = ref('debug'); // 'debug' | 'file-history'
    const orphanItems = ref([]);
    const orphanTotalSize = ref('');

    // ─── 计算属性 ──────────────────────────────────
    const totalSessions = computed(() => projects.value.reduce((s, p) => s + p.sessionCount, 0));
    const debugInfo = computed(() => {
      const dbg = stats.value.breakdown?.find(b => b.name.includes('debug'));
      return { formatted: dbg?.formatted || '—', count: dbg?.count || 0 };
    });
    const fileHistoryInfo = computed(() => {
      const fh = stats.value.breakdown?.find(b => b.name.includes('file-history'));
      return { formatted: fh?.formatted || '—', count: fh?.count || 0 };
    });
    const filteredSessions = computed(() => {
      let list = sessions.value;
      if (hideEmpty.value) list = list.filter(s => s.messageCount > 0);
      if (!sessionFilter.value) return list;
      const kw = sessionFilter.value.toLowerCase();
      return list.filter(s =>
        s.firstUserMsg.toLowerCase().includes(kw) ||
        s.sessionId.toLowerCase().includes(kw) ||
        (s.gitBranch && s.gitBranch.toLowerCase().includes(kw))
      );
    });
    const allSelected = computed(() =>
      filteredSessions.value.length > 0 &&
      filteredSessions.value.every(s => selectedSessions.value.includes(s.sessionId))
    );

    // ─── API ──────────────────────────────────────
    async function api(url, opts = {}) {
      const resp = await fetch(url, opts);
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `API 错误: ${resp.status}`);
      }
      return resp.json();
    }

    // ─── Toast ────────────────────────────────────
    function toast(message, type = 'info') {
      const t = { message, type };
      toasts.value.push(t);
      setTimeout(() => {
        const idx = toasts.value.indexOf(t);
        if (idx !== -1) toasts.value.splice(idx, 1);
      }, 4000);
    }

    // ─── 仪表盘 ───────────────────────────────────
    async function loadDashboard() {
      loading.value = true;
      try {
        const [p, s] = await Promise.all([api('/api/projects'), api('/api/stats')]);
        projects.value = p;
        stats.value = s;
        // 顺便拿回收站计数
        const trash = await api('/api/trash');
        trashCount.value = trash.items.length;
      } catch (e) {
        toast('加载失败: ' + e.message, 'error');
      }
      loading.value = false;
    }

    function goHome() {
      currentView.value = 'dashboard';
      loadDashboard();
    }

    // ─── 项目 → 会话列表 ──────────────────────────
    async function openProject(projectName) {
      currentView.value = 'sessions';
      currentProject.value = projectName;
      // 从 projects 缓存里拿 displayName
      const proj = projects.value.find(p => p.name === projectName);
      currentProjectDisplay.value = proj ? proj.displayName : projectName;
      selectedSessions.value = [];
      sessionFilter.value = '';
      loading.value = true;
      try {
        sessions.value = await api(`/api/sessions?project=${encodeURIComponent(projectName)}`);
      } catch (e) {
        toast('加载会话列表失败: ' + e.message, 'error');
      }
      loading.value = false;
    }

    // ─── 会话详情 ──────────────────────────────────
    async function openSession(project, sessionId) {
      currentView.value = 'detail';
      currentProject.value = project;
      currentSessionId.value = sessionId;
      loading.value = true;
      try {
        const data = await api(`/api/session/${sessionId}?project=${encodeURIComponent(project)}`);
        for (const msg of data.messages) {
          if (msg.type === 'assistant' && msg.message?.content && Array.isArray(msg.message.content)) {
            msg.message.content.forEach(part => {
              if (part.type === 'tool_use') part._open = false;
            });
          }
        }
        detailMessages.value = data.messages;
        detailFiles.value = data.files || {};
        const firstMsg = data.messages.find(m => m.sessionId || m.gitBranch);
        detailMeta.gitBranch = firstMsg?.gitBranch || '';
        detailMeta.version = firstMsg?.version || '';
      } catch (e) {
        toast('加载对话失败: ' + e.message, 'error');
      }
      loading.value = false;
    }

    function backToSessions() {
      currentView.value = 'sessions';
      openProject(currentProject.value);
    }

    // ─── 选择 ─────────────────────────────────────
    function toggleSelect(sessionId) {
      const idx = selectedSessions.value.indexOf(sessionId);
      if (idx !== -1) selectedSessions.value.splice(idx, 1);
      else selectedSessions.value.push(sessionId);
    }
    function toggleSelectAll() {
      if (allSelected.value) selectedSessions.value = [];
      else selectedSessions.value = filteredSessions.value.map(s => s.sessionId);
    }

    // ─── 删除（软删除 → 回收站）─────────────────────
    const SAFETY_NOTE_SOFT = '<strong>安全保障：</strong>数据将移至回收站（<code>~/.claude/trash/</code>），包括对话记录、调试日志、文件编辑历史和 <code>/resume</code> 索引。<br><strong>如何恢复：</strong>在「回收站」页面点击「恢复」即可原路返回。';

    function batchDelete() {
      const count = selectedSessions.value.length;
      confirmDialog.title = `移至回收站 — ${count} 个会话`;
      confirmDialog.message = `选中的 ${count} 个会话将从列表中移除。`;
      confirmDialog.safetyNote = SAFETY_NOTE_SOFT;
      confirmDialog.btnText = '移至回收站';
      confirmDialog.btnClass = 'btn-warning';
      confirmDialog.onConfirm = async () => {
        try {
          await api('/api/sessions/batch-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project: currentProject.value, sessionIds: selectedSessions.value })
          });
          toast(`${count} 个会话已移至回收站，可随时恢复`, 'success');
          selectedSessions.value = [];
          openProject(currentProject.value);
        } catch (e) {
          toast('操作失败: ' + e.message, 'error');
        }
      };
      confirmDialog.show = true;
    }

    function deleteSingle(project, sessionId) {
      confirmDialog.title = '移至回收站';
      confirmDialog.message = `会话 ${sessionId.slice(0, 8)}... 将从列表中移除。`;
      confirmDialog.safetyNote = SAFETY_NOTE_SOFT;
      confirmDialog.btnText = '移至回收站';
      confirmDialog.btnClass = 'btn-warning';
      confirmDialog.onConfirm = async () => {
        try {
          await api(`/api/session/${sessionId}?project=${encodeURIComponent(project)}`, { method: 'DELETE' });
          toast('已移至回收站，可在回收站页面恢复', 'success');
          backToSessions();
        } catch (e) {
          toast('操作失败: ' + e.message, 'error');
        }
      };
      confirmDialog.show = true;
    }

    // ─── 搜索 ─────────────────────────────────────
    async function doGlobalSearch() {
      const q = globalSearch.value.trim();
      if (!q) return;
      searchKeyword.value = q;
      currentView.value = 'search';
      loading.value = true;
      try {
        const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
        searchResults.value = data.results;
      } catch (e) {
        toast('搜索失败: ' + e.message, 'error');
      }
      loading.value = false;
    }

    /** XSS 安全的关键词高亮：先转义 HTML，再插入 <mark> */
    function escapeHtml(text) {
      if (!text) return '';
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function highlightKeyword(text, keyword) {
      if (!text || !keyword) return escapeHtml(text || '');
      const safe = escapeHtml(text);
      const kwSafe = escapeHtml(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return safe.replace(new RegExp(`(${kwSafe})`, 'gi'), '<mark>$1</mark>');
    }

    // ─── 孤立清理 ─────────────────────────────────
    async function openOrphans(type) {
      orphanType.value = type;
      currentView.value = 'orphans';
      loading.value = true;
      try {
        const data = await api(`/api/orphans/${type}`);
        orphanItems.value = data.items;
        orphanTotalSize.value = data.totalFormatted;
      } catch (e) {
        toast('加载孤立列表失败: ' + e.message, 'error');
      }
      loading.value = false;
    }

    async function deleteOrphan(item) {
      const type = orphanType.value;
      const label = type === 'debug' ? '调试日志' : '文件历史';
      confirmDialog.title = `删除孤立${label}`;
      confirmDialog.message = `将永久删除 Session ${item.sessionId.slice(0, 8)}... 的${label}。`;
      confirmDialog.safetyNote = `<strong>注意：</strong>这是孤儿文件，对应的会话已不存在。删除后<strong>不可恢复</strong>。`;
      confirmDialog.btnText = '永久删除';
      confirmDialog.btnClass = 'btn-danger';
      confirmDialog.onConfirm = async () => {
        try {
          const result = await api(`/api/orphans/${type}/${item.sessionId}`, { method: 'DELETE' });
          toast(`已删除，释放 ${result.freedFormatted}`, 'success');
          openOrphans(type);
        } catch (e) {
          toast('删除失败: ' + e.message, 'error');
        }
      };
      confirmDialog.show = true;
    }

    async function cleanAllOrphans() {
      const type = orphanType.value;
      const label = type === 'debug' ? '调试日志' : '文件历史';
      const count = orphanItems.value.length;
      confirmDialog.title = `清理全部孤立${label} — ${count} 项`;
      confirmDialog.message = `将永久删除全部 ${count} 个孤立${label}。`;
      confirmDialog.safetyNote = `<strong>注意：</strong>这些都是"孤儿文件"——对应的会话已不存在，无法通过回收站恢复。但它们也不再有实际用途。`;
      confirmDialog.btnText = '全部清理';
      confirmDialog.btnClass = 'btn-danger';
      confirmDialog.onConfirm = async () => {
        try {
          const data = await api(`/api/cleanup/${type}`, { method: 'POST' });
          toast(`已清理 ${data.cleaned} 个孤立${label}，释放 ${data.freedFormatted}`, 'success');
          openOrphans(type);
        } catch (e) {
          toast('清理失败: ' + e.message, 'error');
        }
      };
      confirmDialog.show = true;
    }

    async function cleanupDebug() {
      openOrphans('debug');
    }

    async function cleanupFileHistory() {
      openOrphans('file-history');
    }

    // ─── 文件管理器打开 ──────────────────────────
    async function openInExplorer(filePath) {
      try {
        await api('/api/open-path', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath })
        });
        toast('已在文件管理器中打开', 'success');
      } catch (e) {
        toast('打开失败: ' + e.message, 'error');
      }
    }

    // ─── 回收站 ───────────────────────────────────
    async function openTrash() {
      currentView.value = 'trash';
      loading.value = true;
      try {
        trashData.value = await api('/api/trash');
        trashCount.value = trashData.value.items.length;
      } catch (e) {
        toast('加载回收站失败: ' + e.message, 'error');
      }
      loading.value = false;
    }

    async function restoreFromTrash(sessionId) {
      try {
        const result = await api(`/api/trash/${sessionId}/restore`, { method: 'POST' });
        toast(`会话已恢复到项目 ${result.project}`, 'success');
        openTrash();
      } catch (e) {
        toast('恢复失败: ' + e.message, 'error');
      }
    }

    function permanentDelete(sessionId) {
      confirmDialog.title = '⚠️ 彻底删除';
      confirmDialog.message = `会话 ${sessionId.slice(0, 8)}... 将被永久删除。`;
      confirmDialog.safetyNote = '<strong>警告：此操作不可逆！</strong>数据将从磁盘上彻底清除，无法再恢复。请确认你已检查过删除后 Claude Code 运行正常。';
      confirmDialog.btnText = '彻底删除';
      confirmDialog.btnClass = 'btn-danger';
      confirmDialog.onConfirm = async () => {
        try {
          const result = await api(`/api/trash/${sessionId}`, { method: 'DELETE' });
          toast(`已彻底删除，释放 ${result.freedFormatted}`, 'success');
          openTrash();
        } catch (e) {
          toast('删除失败: ' + e.message, 'error');
        }
      };
      confirmDialog.show = true;
    }

    function purgeTrash() {
      const count = trashData.value.items.length;
      confirmDialog.title = `⚠️ 清空回收站 — ${count} 项`;
      confirmDialog.message = `回收站中的全部 ${count} 个会话将被永久删除。`;
      confirmDialog.safetyNote = '<strong>警告：此操作不可逆！</strong>所有回收站中的数据将从磁盘彻底清除。建议先逐个检查确认不再需要。';
      confirmDialog.btnText = '全部彻底删除';
      confirmDialog.btnClass = 'btn-danger';
      confirmDialog.onConfirm = async () => {
        try {
          const result = await api('/api/trash/purge', { method: 'POST' });
          toast(`已清空回收站，释放 ${result.freedFormatted}`, 'success');
          openTrash();
        } catch (e) {
          toast('清空失败: ' + e.message, 'error');
        }
      };
      confirmDialog.show = true;
    }

    // ─── 设置 ─────────────────────────────────────
    async function openSettings() {
      currentView.value = 'settings';
      try {
        const data = await api('/api/settings');
        settingsForm.cleanupPeriodDays = data.cleanupPeriodDays;
        settingsFilePath.value = data.settingsFilePath || '';
      } catch (e) {
        toast('加载设置失败: ' + e.message, 'error');
      }
    }

    async function saveSettings() {
      settingsSaving.value = true;
      try {
        await api('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cleanupPeriodDays: settingsForm.cleanupPeriodDays })
        });
        toast(`已保存：自动清理周期 = ${settingsForm.cleanupPeriodDays} 天`, 'success');
      } catch (e) {
        toast('保存失败: ' + e.message, 'error');
      }
      settingsSaving.value = false;
    }

    // ─── 消息解析 ──────────────────────────────────
    const SYSTEM_TAG_RE = /<(ide_opened_file|ide_selection|system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-caveat)[^>]*>[\s\S]*?<\/\1>/g;
    function stripSystemTags(text) {
      if (!text) return '';
      return text.replace(SYSTEM_TAG_RE, '').trim();
    }

    function getUserText(msg) {
      if (!msg.message) return null;
      const c = msg.message.content;
      if (typeof c === 'string') return stripSystemTags(c) || null;
      if (Array.isArray(c)) {
        const textPart = c.find(p => p.type === 'text' && !p.text?.includes('[Request interrupted'));
        const raw = textPart?.text || null;
        return raw ? (stripSystemTags(raw) || null) : null;
      }
      return null;
    }

    function getAssistantText(msg) {
      if (!msg.message?.content) return null;
      const c = msg.message.content;
      if (Array.isArray(c)) {
        const texts = c.filter(p => p.type === 'text').map(p => p.text).join('\n');
        return texts || null;
      }
      return typeof c === 'string' ? c : null;
    }

    function getToolCalls(msg) {
      if (!msg.message?.content || !Array.isArray(msg.message.content)) return [];
      return msg.message.content.filter(p => p.type === 'tool_use');
    }

    function stripTags(str) {
      return str.replace(/<[^>]*>/g, '').trim();
    }

    // ─── 日期格式化 ──────────────────────────────
    function formatDate(isoStr) {
      if (!isoStr) return '—';
      const d = new Date(isoStr);
      return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    function formatTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      return d.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    // ─── 初始化 ──────────────────────────────────
    onMounted(() => loadDashboard());

    return {
      currentView, loading, projects, stats, sessions, selectedSessions, sessionFilter, hideEmpty,
      currentProject, currentProjectDisplay, currentSessionId, detailMessages, detailMeta, detailFiles,
      globalSearch, searchKeyword, searchResults, toasts, confirmDialog,
      trashData, trashCount, settingsForm, settingsSaving, settingsFilePath,
      orphanType, orphanItems, orphanTotalSize,
      totalSessions, debugInfo, fileHistoryInfo, filteredSessions, allSelected,
      goHome, openProject, openSession, backToSessions,
      toggleSelect, toggleSelectAll, batchDelete, deleteSingle,
      doGlobalSearch, highlightKeyword,
      cleanupDebug, cleanupFileHistory, openOrphans, deleteOrphan, cleanAllOrphans,
      openInExplorer,
      openTrash, restoreFromTrash, permanentDelete, purgeTrash,
      openSettings, saveSettings,
      getUserText, getAssistantText, getToolCalls, stripTags, stripSystemTags,
      formatDate, formatTime, escapeHtml
    };
  }
});

app.mount('#app');
