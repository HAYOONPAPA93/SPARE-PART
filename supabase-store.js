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

  function errText(e) {
    if (!e) return 'unknown';
    if (typeof e === 'string') return e;
    return e.message || e.error_description || e.code || JSON.stringify(e);
  }

  function isConfigured() {
    const c = cfg();
    return !!(c.url && c.anonKey && !String(c.url).includes('YOUR_') && !String(c.anonKey).includes('YOUR_'));
  }

  function setStatus(text, ok) {
    if (typeof onStatus === 'function') onStatus(text, ok);
  }

  /** 붙여넣기 실수(따옴표, 슬래시, dashboard 주소 등) 정리 */
  function normalizeUrl(raw) {
    let u = String(raw || '').trim().replace(/^['"`]|['"`]$/g, '');
    const dash = u.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
    if (dash) return 'https://' + dash[1] + '.supabase.co';
    u = u.replace(/\/rest\/v1.*$/i, '').replace(/\/+$/g, '');
    try {
      const p = new URL(u);
      if (/\.supabase\.co$/i.test(p.hostname)) return 'https://' + p.hostname;
    } catch (e) {}
    return u;
  }

  function normalizeKey(raw) {
    return String(raw || '').trim().replace(/^['"`]|['"`]$/g, '').replace(/\s+/g, '');
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
    const key = normalizeKey(c.anonKey);
    const url = normalizeUrl(c.url);

    if (key.startsWith('sb_publishable_') || key.startsWith('sb_secret_')) {
      mode = 'local';
      setStatus('⚠ 키 형식 오류 · Legacy anon(eyJ…) 키를 넣으세요', false);
      return false;
    }
    if (!key.startsWith('eyJ')) {
      mode = 'local';
      setStatus('⚠ anon 키는 eyJ 로 시작해야 합니다', false);
      return false;
    }
    if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/i.test(url)) {
      mode = 'local';
      setStatus('⚠ URL을 https://프로젝트ID.supabase.co 형태로 넣어주세요', false);
      return false;
    }

    client = global.supabase.createClient(url, key);
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
      const local = readLocal();
      if (local) {
        const saved = await persistNow(local, true);
        if (!saved.ok) {
          setStatus('최초 업로드 실패: ' + errText(saved.error), false);
          return { data: local, source: 'local-fallback' };
        }
        setStatus('로컬 → 클라우드 최초 업로드', true);
        return { data: local, source: 'local-upload' };
      }
      setStatus('클라우드 연결됨 (새 데이터)', true);
      return { data: null, source: 'cloud-empty' };
    } catch (e) {
      console.warn('[Supabase] load failed', e);
      const msg = errText(e);
      if (/relation .* does not exist|Could not find the table/i.test(msg)) {
        setStatus('실패: app_state 테이블 없음 · SQL 다시 실행', false);
      } else if (/JWT|Invalid API key|API key/i.test(msg)) {
        setStatus('실패: API 키 오류 · Legacy anon(eyJ…) 확인', false);
      } else {
        setStatus('클라우드 실패: ' + msg, false);
      }
      return { data: readLocal(), source: 'local-fallback' };
    }
  }

  async function persistNow(payload, force) {
    writeLocal(payload);
    const json = JSON.stringify(payload);
    if (!force && json === lastSavedJson) return { ok: true, skipped: true };
    if (mode !== 'cloud' || !client || applyingRemote) {
      lastSavedJson = json;
      return { ok: true, localOnly: true };
    }
    try {
      const { error } = await client.from('app_state').upsert(
        {
          id: ROW_ID,
          payload,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' }
      );
      if (error) throw error;
      lastSavedJson = json;
      setStatus('클라우드 저장됨 · ' + new Date().toLocaleTimeString('ko-KR'), true);
      return { ok: true };
    } catch (e) {
      console.warn('[Supabase] save failed', e);
      const msg = errText(e);
      if (/relation .* does not exist|Could not find the table/i.test(msg)) {
        setStatus('저장 실패: 테이블 없음 · SQL 실행 필요', false);
      } else if (/JWT|Invalid API key|API key|permission|RLS|policy/i.test(msg)) {
        setStatus('저장 실패: 키/권한 오류 · Legacy anon 키 확인', false);
      } else {
        setStatus('저장 실패: ' + msg, false);
      }
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
