import { Component, type ReactNode } from 'react';

export class WorkspaceSectionBoundary extends Component<
  { scope: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidUpdate(previous: Readonly<{ scope: string; children: ReactNode }>) {
    if (previous.scope !== this.props.scope && this.state.failed) this.setState({ failed: false });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="empty section-unavailable" role="alert">
        <h1>Chưa mở được mục công việc này</h1>
        <p>
          Thử tải lại trang hoặc chọn một mục khác ở thanh điều hướng. Các bộ nguồn đã lưu vẫn được
          giữ trong ứng dụng.
        </p>
        <button className="primary" onClick={() => window.location.reload()}>
          Tải lại ứng dụng
        </button>
        <details>
          <summary>Thông tin để hỗ trợ</summary>
          <code>CLIENT_SECTION_UNAVAILABLE</code>
        </details>
      </section>
    );
  }
}
