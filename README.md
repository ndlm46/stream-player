# 🎵 YT Stream Player

Trình phát nhạc YouTube trực tuyến chất lượng cao (Opus/AAC) với giao diện hiện đại, hỗ trợ PWA và cơ chế Bypass YouTube BotGuard PoToken tự động.

![YT Stream Player Preview](public/icons/icon-512.png)

## ✨ Tính năng nổi bật

- 🎧 **Âm thanh chất lượng cao**: Hỗ trợ chuẩn **Opus 160kbps (itag 251)** và **AAC 128kbps (itag 140)**.
- 🛡️ **Bypass YouTube PoToken**: Tích hợp BotGuard Minter tự động sinh **Video-Bound PoToken (< 1ms)** để mở khóa stream không bị giới hạn 1MB từ YouTube CDN.
- ⚡ **Proxy Streaming mượt mà**: Hỗ trợ phân đoạn `512KB/chunk`, chuẩn `HTTP 206 Partial Content` giúp tua nhạc (seek) nhanh và tiết kiệm băng thông.
- 📱 **Hỗ trợ PWA**: Có thể cài đặt trực tiếp trên điện thoại (iOS / Android) và máy tính như ứng dụng native.
- 🔍 **Tìm kiếm & Gợi ý (Trending)**: Tìm kiếm bài hát theo từ khóa hoặc dán trực tiếp YouTube URL.

---

## 🚀 Cài đặt & Khởi chạy

### Yêu cầu
- **Node.js**: v18+ (khuyến nghị v20+)
- **NPM**: v9+

### Các bước cài đặt

```bash
# 1. Cài đặt các thư viện phụ thuộc
npm install

# 2. Khởi chạy server
npm start

# Hoặc chạy ở chế độ dev (tự động reload khi sửa code)
npm run dev
```

Truy cập trình duyệt tại: **http://localhost:3210**

---

## 🛠️ Công nghệ sử dụng

- **Backend**: Node.js, Express 5, `youtubei.js` (v18), `bgutils-js` (v4), `jsdom`
- **Frontend**: HTML5, Modern CSS (Glassmorphism), Vanilla JavaScript, Service Worker (PWA)

---

## 📝 Tài liệu nâng cấp & Sửa lỗi
Chi tiết về quá trình sửa lỗi `ERR_CONTENT_LENGTH_MISMATCH`, cơ chế YouTube BotGuard PoToken và giải mã chữ ký được lưu tại [UPGRADE_NOTES.md](UPGRADE_NOTES.md).
