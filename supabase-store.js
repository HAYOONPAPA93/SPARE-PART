/**
 * Spare Parts ↔ Supabase 공용 저장 헬퍼
 * 의존: supabase-config.js, @supabase/supabase-js CDN
 */
(function (global) {
  const ROW_ID = 'main';
  const LOCAL_KEYS = ['spare-parts-html-v4', 'spare-parts-html-v3'];

  let client = null;
  let mode = 'local'; // 'cloud' | 'local'
  let saveTimer = null;
  let applyingRemote = false;
  let lastSavedJson = '';
  let onRemote = null;
  let onStatus = null;

  function cfg() {
    return global.SPARE_PARTS_SUPABASE || {};
  }

  function isConfigured() {
    const c = cfg();
    return !!(c.url && c.anonKey && !String(c.url).includes('YOUR_') && !String(c.anonKey).includes('YOUR_'));
  }

  function setStatus(text, ok) {
    if (typeof onStatus === 'function') onStatus(text, ok);
  }

  function init(handlers) {
    onRemote = handlers && handlers.onRemote;
    onStatus = handlers && handlers.onStatus;
    if (!isConfigured()) {
      mode = 'local';
      setStatus('⚠ 공용저장 미설정 · supabase-config.js에 URL/키 필요', false);
      return false;
    }
    if (!global.supabase || !global.supabase.createClient) {
      mode = 'local';
      setStatus('로컬 저장 (SDK 로드 실패)', false);
      return false;
    }
    const c = cfg();
    client = global.supabase.createClient(c.url, c.anonKey);
    mode = 'cloud';
    setStatus('클라우드 연결됨', true);
    return true;
  }

  function readLocal() {
    try {
      for (const key of LOCAL_KEYS) {
        const raw = localStorage.getItem(key);
        if (raw) return JSON.parse(raw);
      }
    } catch (e) {}
    return null;
  }

  function writeLocal(payload) {
    try {
      localStorage.setItem(LOCAL_KEYS[0], JSON.stringify(payload));
    } catch (e) {}
  }

  async function load() {
    if (mode !== 'cloud' || !client) {
      return { data: readLocal(), source: 'local' };
    }
    try {
      const { data, error } = await client
        .from('app_state')
        .select('payload, updated_at')
        .eq('id', ROW_ID)
        .maybeSingle();
      if (error) throw error;
      const payload = data && data.payload;
      const hasCloud = payload && (payload.ledgerItems || payload.criteria);
      if (hasCloud) {
        writeLocal(payload);
        lastSavedJson = JSON.stringify(payload);
        setStatus('클라우드 데이터 로드됨', true);
        return { data: payload, source: 'cloud', updatedAt: data.updated_at };
      }
      // 클라우드 비어 있으면 로컬을 업로드
      const local = readLocal();
      if (local) {
        await persistNow(local);
        setStatus('로컬 → 클라우드 최초 업로드', true);
        return { data: local, source: 'local-upload' };
      }
      setStatus('클라우드 연결됨 (새 데이터)', true);
      return { data: null, source: 'cloud-empty' };
    } catch (e) {
      console.warn('[Supabase] load failed', e);
      setStatus('클라우드 실패 → 로컬 사용', false);
      return { data: readLocal(), source: 'local-fallback' };
    }
  }

  async function persistNow(payload) {
    writeLocal(payload);
    const json = JSON.stringify(payload);
    if (json === lastSavedJson) return { ok: true, skipped: true };
    if (mode !== 'cloud' || !client || applyingRemote) {
      lastSavedJson = json;
      return { ok: true, localOnly: true };
    }
    try {
      const { error } = await client.from('app_state').upsert({
        id: ROW_ID,
        payload,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      lastSavedJson = json;
      setStatus('클라우드 저장됨 · ' + new Date().toLocaleTimeString('ko-KR'), true);
      return { ok: true };
    } catch (e) {
      console.warn('[Supabase] save failed', e);
      setStatus('저장 실패 (로컬만 유지)', false);
      return { ok: false, error: e };
    }
  }

  function save(payload, immediate) {
    writeLocal(payload);
    if (saveTimer) clearTimeout(saveTimer);
    if (immediate) return persistNow(payload);
    return new Promise((resolve) => {
      saveTimer = setTimeout(async () => {
        resolve(await persistNow(payload));
      }, 500);
    });
  }

  function subscribe() {
    if (mode !== 'cloud' || !client) return;
    client
      .channel('spare-parts-app-state')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'app_state', filter: 'id=eq.' + ROW_ID },
        (msg) => {
          const payload = msg.new && msg.new.payload;
          if (!payload) return;
          const json = JSON.stringify(payload);
          if (json === lastSavedJson) return;
          applyingRemote = true;
          lastSavedJson = json;
          writeLocal(payload);
          setStatus('다른 사용자 변경 반영 · ' + new Date().toLocaleTimeString('ko-KR'), true);
          try {
            if (typeof onRemote === 'function') onRemote(payload);
          } finally {
            applyingRemote = false;
          }
        }
      )
      .subscribe();
  }

  global.SparePartsStore = {
    init,
    load,
    save,
    persistNow,
    subscribe,
    isConfigured,
    getMode: () => mode,
  };
})(window);
