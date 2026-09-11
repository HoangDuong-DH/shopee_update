import { useState } from 'react';
import type { ShopConnection } from '@shopee/domain';
import { post } from './api.js';
export function ConnectionForm({
  shop,
  onConnected,
}: {
  shop: ShopConnection;
  onConnected: () => void;
}) {
  const [key, setKey] = useState(''),
    [token, setToken] = useState(''),
    [refresh, setRefresh] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function connect() {
    setBusy(true);
    setMessage('');
    try {
      const r = await post<any>('/v1/connections/sandbox', {
        connectionId: shop.id,
        expectedRevision: shop.scope.connectionRevision,
        partnerKey: key || undefined,
        accessToken: token,
        refreshToken: refresh || undefined,
      });
      setKey('');
      setToken('');
      setRefresh('');
      if (r.kind === 'success') {
        setMessage(
          'Đã gọi API trực tiếp thành công · ' +
            r.info.shopName +
            ' · mã yêu cầu ' +
            (r.info.requestId ?? 'không có'),
        );
        onConnected();
      } else
        setMessage(
          r.kind === 'rejected'
            ? 'Shopee trả lỗi: ' + r.code
            : 'Chưa xác minh được kết nối. Kiểm tra mạng và thông tin TEST rồi thử lại.',
        );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="connection-form">
      <summary>Cấu hình kết nối sandbox trực tiếp</summary>
      <p>
        Nhập thông tin TEST từ Open Platform Console cho partner {shop.scope.partnerId}, shop{' '}
        {shop.scope.shopId}. Bước này chỉ đọc thông tin shop.
      </p>
      <label>
        Sandbox Access Token
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      <p className="caption">
        Khi làm mới kết nối, chỉ cần dán Access Token mới. Partner Key đã lưu được dùng lại trên
        server.
      </p>
      <details open={shop.state === 'disconnected' ? true : undefined}>
        <summary>Partner Key lần đầu / đổi khóa hoặc bổ sung Refresh Token</summary>
        <label>
          Test Partner Key
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <p className="caption">
          Lần đầu kết nối cần nhập key tại{' '}
          <a href="https://open.shopee.com/console/app" target="_blank" rel="noreferrer">
            App List
          </a>{' '}
          → app có Test Partner ID {shop.scope.partnerId} → APP Key → Test API Partner Key. Những
          lần sau để trống để giữ key đã lưu của đúng kết nối này.
        </p>
        <label>
          Sandbox Refresh Token · nếu có
          <input
            type="password"
            autoComplete="off"
            value={refresh}
            onChange={(e) => setRefresh(e.target.value)}
          />
        </label>
        <p className="caption">
          Để trống sẽ giữ Refresh Token đã lưu, nếu có. Ứng dụng chưa tự làm mới token.
        </p>
      </details>
      <p className="caption">
        Lấy access_token tại{' '}
        <a href="https://open.shopee.com/console/tools/api-test" target="_blank" rel="noreferrer">
          API Test Tool
        </a>
        : chọn partner {shop.scope.partnerId} → Shop → v2.shop.get_shop_info. Kiểm tra Request URL
        là sandbox.test-stable, nhập shop_id {shop.scope.shopId}, bấm Get Access Token. Ô
        access_token nằm trong Common Parameters, ngay dưới shop_id. Refresh Token có thể để trống ở
        bước này. Không gửi khóa/token qua chat.
      </p>
      <button
        className="primary"
        disabled={busy || (key.length > 0 && key.trim().length < 8) || token.trim().length < 8}
        onClick={() => void connect()}
      >
        {busy ? 'Đang gọi API đọc shop…' : 'Kiểm tra & lưu kết nối TEST'}
      </button>
      {message && <p role="status">{message}</p>}
      <p className="caption">
        Khóa được mã hóa ở server, không lưu trong trình duyệt. Đây là kết nối thử bằng token hiện
        có; cơ chế cấp quyền và tự làm mới token chưa được nghiệm thu.
      </p>
    </details>
  );
}
