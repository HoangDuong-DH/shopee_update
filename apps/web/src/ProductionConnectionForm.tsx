import { useEffect, useRef, useState } from 'react';
import { api, post, RequestError } from './api.js';

type Target = {
  connectionId:string|null; tokenExpiresAt:string|null; autoRefresh:boolean; refreshStatus:string; refreshReason:string|null;
  partnerId: string;
  shopId: string;
  expectedHandle: string;
  appName: string;
  consoleUrl: string;
  connectionRevision: number;
  hasSavedKey: boolean;
  officialName: string | null;
  state: string;
};
type AuthorizationAttempt = {
  attemptId: string;
  authorizationUrl: string;
  callbackUrl: string;
  expiresAt: string | number;
};
type AuthorizationStatus =
  'pending' | 'exchanging' | 'verified' | 'rejected' | 'unknown' | 'expired';
type AuthorizationResult = { status: AuthorizationStatus; connectionRevision?: number; reason?:string };
const authorizationMessages: Record<AuthorizationStatus, string> = {
  pending: 'Đang chờ bạn cấp quyền trên Shopee. Giữ ứng dụng này mở để nhận kết quả.',
  exchanging: 'Đã nhận phản hồi cấp quyền. Backend đang kiểm tra kết nối với đúng shop.',
  verified: 'Đã xác minh và lưu kết nối đọc thông tin shop. Chưa gửi sản phẩm lên Shopee.',
  rejected:
    'Chưa kết nối được: yêu cầu cấp quyền bị từ chối hoặc không khớp shop đã chọn. Kiểm tra đúng shop rồi chuẩn bị lại.',
  unknown:
    'Chưa xác nhận được kết quả kết nối. Tải lại trạng thái kết nối để kiểm tra trước khi làm tiếp.',
  expired:
    'Liên kết cấp quyền đã hết thời gian chờ. Tải lại trạng thái kết nối; nếu chưa kết nối, chuẩn bị liên kết mới.',
};
function publicError(error: unknown) {
  if (error instanceof RequestError) return error.message;
  return 'Chưa xử lý được kết nối. Tải lại trạng thái để kiểm tra; không gửi khóa hoặc token vào chat.';
}
export function ProductionConnectionForm({ onConnected }: { onConnected: () => void }) {
  const [partnerId,setPartnerId]=useState(()=>{const v=new URLSearchParams(window.location.search).get('partnerId');return v&&/^[1-9]\d{0,9}$/.test(v)?v:'2010476';});
  const [shopId,setShopId]=useState(()=>{const v=new URLSearchParams(window.location.search).get('connectShop');return v&&/^[1-9]\d{0,15}$/.test(v)?v:'1423724897';});
  const [shops,setShops]=useState<{id:string;name:string;scope:{environment:string;partnerId:string;shopId:string}}[]>([]);
  const [target, setTarget] = useState<Target | null>(null);
  const [partnerKey, setPartnerKey] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState<AuthorizationAttempt | null>(null);
  const [authorizationStatus, setAuthorizationStatus] = useState<AuthorizationStatus | null>(null);
  const mounted = useRef(false);
  const onConnectedRef = useRef(onConnected);
  const loadVersion = useRef(0);
  onConnectedRef.current = onConnected;
  async function load(signal?: AbortSignal,selected={partnerId,shopId}) {
    const version=++loadVersion.current;
    const next = await api<Target>('/v1/connections/production?'+new URLSearchParams(selected), { signal });
    if (mounted.current && !signal?.aborted && version===loadVersion.current) {
      setTarget(next);
      if(next.connectionId)setShops(rows=>[...rows.filter(r=>r.id!==next.connectionId),{id:next.connectionId!,name:next.officialName??next.expectedHandle,scope:{environment:'production',partnerId:next.partnerId,shopId:next.shopId}}]);
    }
  }
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void api<typeof shops>('/v1/shops',{signal:controller.signal}).then(rows=>{if(!controller.signal.aborted)setShops(rows.filter(r=>r.scope.environment==='production'));}).catch(()=>{});
    const saved=sessionStorage.getItem('shopee-authorization-attempt');
    let selected={partnerId,shopId};
    if(saved)try {
      const state=JSON.parse(saved),url=new URL(state.attempt.authorizationUrl),callback=new URL(state.attempt.callbackUrl);
      if(url.origin!=='https://open.shopee.com'||url.pathname!=='/auth'||url.username||url.password||callback.href!=='http://127.0.0.1:4310/v1/connections/production-pilot/callback'||!/^[0-9a-f-]{36}$/i.test(state.attempt.attemptId)||!/^\d+$/.test(state.partnerId)||!/^\d+$/.test(state.shopId))throw Error('INVALID_SAVED_ATTEMPT');
      if(Date.parse(state.attempt.expiresAt)>Date.now()){selected={partnerId:state.partnerId,shopId:state.shopId};setPartnerId(state.partnerId);setShopId(state.shopId);setAttempt(state.attempt);setAuthorizationStatus('pending');}
    } catch {sessionStorage.removeItem('shopee-authorization-attempt');}
    void load(controller.signal,selected).catch(() => {
      if (!controller.signal.aborted) setMessage('Chưa tải được kết nối shop thật. Bấm tải lại.');
    });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, []);
  useEffect(()=>{
    if(!target || busy)return;
    const controller=new AbortController();
    let inflight=false;
    const update=async()=>{if(document.hidden||inflight)return;inflight=true;try{await load(controller.signal,{partnerId:target.partnerId,shopId:target.shopId});}catch{}finally{inflight=false;}};
    const timer=setInterval(()=>void update(),30000);
    window.addEventListener('focus',update);
    return()=>{clearInterval(timer);window.removeEventListener('focus',update);controller.abort();};
  },[target?.partnerId,target?.shopId,busy]);
  useEffect(() => {
    if (!attempt) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    const parsedExpiry =
      typeof attempt.expiresAt === 'number'
        ? attempt.expiresAt < 1_000_000_000_000
          ? attempt.expiresAt * 1000
          : attempt.expiresAt
        : Date.parse(attempt.expiresAt);
    const expiry = Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now();
    const deadline = setTimeout(
      () => {
        if (ended) return;
        ended = true;
        controller.abort();
        clearTimeout(timer);
        setAuthorizationStatus('expired');
        setMessage(authorizationMessages.expired);
      },
      Math.max(0, expiry - Date.now()),
    );
    async function poll() {
      if (ended || controller.signal.aborted) return;
      if (Date.now() >= expiry) {
        ended = true;
        setAuthorizationStatus('expired');
        setMessage(authorizationMessages.expired);
        return;
      }
      try {
        const result = await api<AuthorizationResult>(
          `/v1/connections/production-pilot/authorization/${encodeURIComponent(attempt!.attemptId)}`,
          { signal: controller.signal },
        );
        if (ended || controller.signal.aborted) return;
        const status = Object.hasOwn(authorizationMessages, result.status)
          ? result.status
          : 'unknown';
        setAuthorizationStatus(status);
        setMessage(result.reason==='UNEXPECTED_GRANT_SCOPE'
          ? 'Shopee trả về danh sách quyền không có shop đã chọn. Kiểm tra Shop ID và quyền của main account rồi chuẩn bị phiên mới.'
          : authorizationMessages[status]);
        if (status === 'pending' || status === 'exchanging') {
          timer = setTimeout(() => void poll(), Math.max(0, Math.min(3000, expiry - Date.now())));
          return;
        }
        ended = true;
        sessionStorage.removeItem('shopee-authorization-attempt');
        if (status === 'verified') {
          try {
            await load(controller.signal);
          } catch {
            if (!controller.signal.aborted)
              setMessage(
                'Đã xác minh kết nối, nhưng chưa tải lại được thông tin shop. Bấm tải lại trạng thái; chưa gửi sản phẩm.',
              );
          }
          if (!controller.signal.aborted) onConnectedRef.current();
        }
      } catch {
        if (controller.signal.aborted) return;
        ended = true;
        setAuthorizationStatus('unknown');
        setMessage(authorizationMessages.unknown);
      }
    }
    timer = setTimeout(() => void poll(), 3000);
    return () => {
      ended = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      controller.abort();
    };
  }, [attempt]);
  const waiting = authorizationStatus === 'pending' || authorizationStatus === 'exchanging';
  const keyReady =
    Boolean(target && (target.hasSavedKey || partnerKey.trim().length >= 8)) &&
    (partnerKey.trim().length === 0 || partnerKey.trim().length >= 8);
  async function prepareAuthorization() {
    if (!target || busy || waiting || !keyReady) return;
    setBusy(true);
    setMessage('Đang chuẩn bị liên kết cấp quyền cho shop đã chọn…');
    try {
      const result = await post<AuthorizationAttempt>(
        '/v1/connections/production/authorize',
        {
          partnerId: target.partnerId,
          shopId: target.shopId,
          expectedRevision: target.connectionRevision,
          partnerKey: partnerKey.trim() || undefined,
        },
      );
      if (!mounted.current) return;
      // Only the official authorization origin may become a clickable external action.
      const url = new URL(result.authorizationUrl);
      const callback = new URL(result.callbackUrl);
      if (
        url.origin !== 'https://open.shopee.com' ||
        url.username ||
        url.password ||
        callback.origin !== 'http://127.0.0.1:4310' ||
        callback.pathname !== '/v1/connections/production-pilot/callback' ||
        callback.username ||
        callback.password ||
        callback.search ||
        callback.hash
      ) {
        setMessage(
          'Liên kết cấp quyền hoặc địa chỉ nhận kết quả không đúng cấu hình. Chưa mở trang và chưa xác nhận kết nối.',
        );
        return;
      }
      setPartnerKey('');
      sessionStorage.setItem('shopee-authorization-attempt',JSON.stringify({partnerId:target.partnerId,shopId:target.shopId,attempt:result}));
      setAttempt(result);
      setAuthorizationStatus('pending');
      setMessage(authorizationMessages.pending);
    } catch (error) {
      if (mounted.current) setMessage(publicError(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function connect() {
    if (!target || busy || waiting) return;
    setBusy(true);
    setMessage('Đang gọi API đọc thông tin shop…');
    try {
      const result = await post<any>('/v1/connections/production', {
        partnerId: target.partnerId,
        shopId: target.shopId,
        expectedRevision: target.connectionRevision,
        partnerKey: partnerKey.trim() || undefined,
        accessToken: accessToken.trim(),
        refreshToken: refreshToken.trim() || undefined,
      });
      if (!mounted.current) return;
      if (result.kind === 'success') {
        setPartnerKey('');
        setAccessToken('');
        setRefreshToken('');
        setAttempt(null);
        setAuthorizationStatus(null);
        setMessage(
          `Đã kết nối API: ${result.info.shopName} · Shop ${target.shopId}. Đã lưu kết nối đọc shop; chưa gửi sản phẩm.`,
        );
        try {
          await load();
        } catch {
          if (mounted.current)
            setMessage(
              'Đã lưu kết nối đọc shop. Chưa tải lại được thông tin; bấm tải lại trạng thái.',
            );
        }
        if (mounted.current) onConnectedRef.current();
      } else if (result.kind === 'rejected') {
        const reasons: Record<string, string> = {
          error_partner_key_expired:
            'Khóa Live đã hết hạn. Mở VestaPro và đổi Live Partner Key trước khi kết nối.',
          error_sign: 'Chữ ký không hợp lệ. Kiểm tra Live Partner Key của đúng ứng dụng.',
          invalid_acceess_token:
            'Access Token không hợp lệ hoặc đã hết hạn. Lấy token production của đúng shop.',
          error_auth: 'Shopee chưa chấp nhận quyền truy cập hoặc token của shop này.',
          partner_shop_no_link: 'Shop chưa cấp quyền cho ứng dụng production này.',
          shop_no_linked: 'Shop chưa cấp quyền cho ứng dụng production này.',
        };
        setMessage(
          reasons[result.code] ??
            'Shopee từ chối kết nối. Kiểm tra quyền ứng dụng và shop trong Console.',
        );
      } else setMessage('Chưa nhận được kết quả đọc shop hợp lệ. Chưa lưu kết nối mới.');
    } catch (error) {
      if (mounted.current) setMessage(publicError(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function maintain(action:'refresh'|'check') {
    if(!target?.connectionId || busy || waiting)return;
    setBusy(true);setMessage(action==='refresh'?'Đang gia hạn kết nối…':'Đang kiểm tra quyền truy cập trên Shopee…');
    try {
      const result=await post<{kind:string;code?:string}>(`/v1/connections/${target.connectionId}/${action}`,{expectedRevision:target.connectionRevision});
      await load(undefined,{partnerId:target.partnerId,shopId:target.shopId});onConnectedRef.current();
      setMessage(result.kind==='success'||result.kind==='already_saved' ? (action==='refresh'?'Đã gia hạn và lưu kết nối.':'Shopee đã xác nhận quyền truy cập ở lần kiểm tra này.') : result.kind==='waiting'?'Chưa thể gia hạn vì có thao tác khác đang giữ kết nối. Ứng dụng sẽ thử lại khi an toàn.':'Chưa xác nhận kết nối hoạt động. Xem trạng thái bên dưới; cấp quyền lại nếu được yêu cầu.');
    }catch(error){setMessage(publicError(error));}finally{setBusy(false);}
  }
  const healthText:Record<string,string>={connected:target?.tokenExpiresAt?'Token còn hạn theo dữ liệu đã lưu':'Đã lưu kết nối; chưa biết thời hạn token',token_expired:'Token đã hết hạn — cần gia hạn',reauth_required:'Cần kiểm tra cấu hình hoặc cấp quyền lại',refresh_unknown:'Lần gia hạn chưa rõ kết quả — không tự gửi lại token',disconnected:'Chưa kết nối'};
  return (
    <section className="panel connection-form" aria-label="Kết nối production đã chọn">
      <span className="tag danger">KẾT NỐI SHOP THẬT</span>
      <div className="form-grid">
        <label>Shop đã lưu<select disabled={busy||waiting} value={target?.connectionId ?? ''} onChange={e=>{const selected=shops.find(s=>s.id===e.target.value);if(!selected)return;setPartnerId(selected.scope.partnerId);setShopId(selected.scope.shopId);setPartnerKey('');setAccessToken('');setRefreshToken('');setTarget(null);setMessage('');void load(undefined,selected.scope).catch(()=>setMessage('Chưa tải được kết nối.'));}}><option value="">Chọn shop / kết nối mới</option>{shops.map(s=><option key={s.id} value={s.id}>{s.name} · {s.scope.shopId}</option>)}</select></label>
        <label>Partner ID<input inputMode="numeric" value={partnerId} disabled={busy||waiting} onChange={e=>{++loadVersion.current;setTarget(null);setPartnerId(e.target.value.trim());}}/></label>
        <label>Shop ID<input inputMode="numeric" value={shopId} disabled={busy||waiting} onChange={e=>{++loadVersion.current;setTarget(null);setShopId(e.target.value.trim());}}/></label>
        <button type="button" disabled={busy||waiting||!/^\d+$/.test(partnerId)||!/^\d+$/.test(shopId)} onClick={()=>{setTarget(null);setPartnerKey('');setAccessToken('');setRefreshToken('');void load().catch(()=>setMessage('Không tải được shop. Kiểm tra Partner ID và Shop ID.'));}}>Chọn shop này</button>
      </div>
      <h2>{target?.expectedHandle ?? 'Kết nối production'}</h2>
      {target && (
        <>
          <p>
            {target.appName} · Partner {target.partnerId} · Shop {target.shopId}
          </p>
          <div className="notice" role="status">
            <strong>{healthText[target.state] ?? 'Cần kiểm tra kết nối'}</strong>
            {target.tokenExpiresAt && <p>Thời hạn token: {new Date(target.tokenExpiresAt).toLocaleString('vi-VN')}</p>}
            <p>{target.autoRefresh?'Tự gia hạn khi ứng dụng đang chạy. Sau khi tắt máy, hệ thống kiểm tra lại lúc mở ứng dụng.':'Tự gia hạn đang tắt.'}</p>
            {target.refreshStatus==='waiting' && <p>Đang chờ điều kiện an toàn để gia hạn. Nếu có đợt đăng chưa rõ kết quả, mở đợt đó để xử lý.</p>}
            {target.refreshStatus==='unknown' && <p>Ứng dụng giữ bằng chứng lần gia hạn. Bấm Gia hạn để phục hồi từ bằng chứng; nếu không thể phục hồi, cấp quyền lại.</p>}
            {target.refreshStatus==='reauth_required' && <p>Cấp quyền lại cho đúng shop; kiểm tra Live Partner Key nếu đã thay đổi trên Shopee.</p>}
            {target.connectionId && <div className="actions">
              <button type="button" disabled={busy||waiting} onClick={()=>void maintain('check')}>Kiểm tra với Shopee</button>
              <button type="button" disabled={busy||waiting} onClick={()=>void maintain('refresh')}>Gia hạn / phục hồi kết nối</button>
              <button type="button" disabled={busy||waiting} onClick={async()=>{setBusy(true);try{await post(`/v1/connections/${target.connectionId}/auto-refresh`,{enabled:!target.autoRefresh,expectedRevision:target.connectionRevision});await load();}catch(error){setMessage(publicError(error));}finally{setBusy(false);}}}>{target.autoRefresh?'Tắt tự gia hạn':'Bật tự gia hạn'}</button>
            </div>}
          </div>
          {target.officialName && <p>Tên shop từ lần kiểm API đã lưu: {target.officialName}</p>}
          <p>
            Kết nối một lần để ứng dụng nhận quyền truy cập đúng shop. Bước này kiểm tra thông tin
            shop và lưu kết nối mã hóa; chưa đăng sản phẩm.
          </p>
          <p>
            <a href={target.consoleUrl} target="_blank" rel="noreferrer">
              Mở ứng dụng trong Shopee Open Platform
            </a>
          </p>
          <label>
            1. Nhập Live Partner Key — khóa Live vừa lưu
            <input
              type="password"
              autoComplete="off"
              disabled={busy || waiting}
              value={partnerKey}
              aria-describedby="production-key-help"
              onChange={(e) => setPartnerKey(e.target.value)}
            />
          </label>
          <p id="production-key-help" className="caption">
            {target.hasSavedKey
              ? 'Đã có khóa lưu mã hóa. Để trống để dùng lại; nếu vừa đổi khóa trên Shopee, nhập khóa mới tại đây.'
              : 'Sao chép khóa Live từ VestaPro và dán tại đây. Không cần tự tìm Access Token.'}
          </p>
          <button
            type="button"
            className="primary"
            disabled={busy || waiting || !keyReady}
            onClick={() => void prepareAuthorization()}
          >
            {busy ? 'Đang xử lý…' : '2. Chuẩn bị kết nối Shopee'}
          </button>
          {waiting && <button type="button" disabled={busy} onClick={async()=>{if(!attempt)return;setBusy(true);try{const result=await post<AuthorizationResult>(`/v1/connections/production-pilot/authorization/${attempt.attemptId}/cancel`,{});setAttempt(null);setAuthorizationStatus(null);sessionStorage.removeItem('shopee-authorization-attempt');await load();setMessage(result.status==='verified'?'Kết nối đã hoàn tất trước khi hủy.':'Đã hủy phiên cấp quyền đang chờ. Bạn có thể chọn shop khác.');}catch(error){setMessage(publicError(error));}finally{setBusy(false);}}}>Hủy phiên cấp quyền</button>}
          {attempt && waiting && (
            <div className="panel" aria-label="Cấp quyền trên Shopee">
              <h3>3. Mở Shopee và cấp quyền đúng shop</h3>
              <p>
                Dùng tài khoản chính của shop hoặc tài khoản quản lý chính, không dùng tài khoản
                phụ. Tại Shopee, kiểm tra ứng dụng {target.appName} và chỉ chọn shop{' '}
                <strong>
                  {target.expectedHandle} · {target.shopId}
                </strong>
                . Không chọn Auth Merchant hoặc shop khác.
              </p>
              <p>
                <a
                  className="primary"
                  href={attempt.authorizationUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Mở Shopee để cấp quyền
                </a>
              </p>
              <p>
                Sau khi đồng ý, Shopee đưa bạn về trang xác nhận. Giữ ứng dụng này mở; kết quả sẽ
                hiện tại đây. Không sao chép mã hoặc đường dẫn trả về vào chat.
              </p>
              <details>
                <summary>Cấu hình Redirect URL Domain — nếu Shopee yêu cầu</summary>
                <p>
                  Trong Edit APP → Authorization Information, ô{' '}
                  <strong>Live Redirect URL Domain</strong> cần khớp miền nhận kết quả:
                </p>
                <p>
                  <code>{new URL(attempt.callbackUrl).origin}</code>
                </p>
                <p>
                  Địa chỉ nhận cấp quyền của backend: <code>{attempt.callbackUrl}</code>
                </p>
                <p>
                  Ứng dụng chưa xác nhận ô này đã được lưu trong Shopee Console. Giữ ứng dụng đang
                  chạy trên máy này khi cấp quyền.
                </p>
              </details>
            </div>
          )}
          <p className="caption">
            Không gửi khóa/token vào chat. Đăng nhập Kênh Người bán chưa thay thế bước cấp quyền
            Open Platform.
          </p>
          <details>
            <summary>Đã có token? Nhập thủ công</summary>
            <p>
              Dành cho trường hợp bạn đã có token production của đúng ứng dụng và shop. Khóa Live
              dùng ô phía trên.
            </p>
            <label>
              Production Access Token
              <input
                type="password"
                autoComplete="off"
                disabled={busy || waiting}
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
              />
            </label>
            <label>
              Production Refresh Token
              <input
                type="password"
                autoComplete="off"
                disabled={busy || waiting}
                value={refreshToken}
                onChange={(e) => setRefreshToken(e.target.value)}
              />
            </label>
            <p>Để trống sẽ giữ token làm mới đã lưu. Nếu token này thuộc lần cấp quyền mới, hãy nhập cả Access Token và Refresh Token tương ứng; nên dùng luồng cấp quyền phía trên.</p>
            <button
              type="button"
              disabled={
                busy ||
                waiting ||
                !keyReady ||
                accessToken.trim().length < 8 ||
                (refreshToken.trim().length > 0 && refreshToken.trim().length < 8)
              }
              onClick={() => void connect()}
            >
              Kiểm tra & lưu kết nối production bằng token
            </button>
          </details>
        </>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void load().catch(() => setMessage('Chưa tải được kết nối. Kiểm tra lại API nội bộ.'))
        }
      >
        Tải lại trạng thái kết nối
      </button>
      {message && (
        <p role="status" aria-live="polite">
          {message}
        </p>
      )}
    </section>
  );
}
