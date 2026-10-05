# Mở ListingStudio

Máy mới: làm theo [START_HERE](docs/onboarding/START_HERE.md), chạy SETUP_LISTINGSTUDIO.cmd một lần rồi START_LISTINGSTUDIO.cmd.

Dùng hằng ngày: mở Docker Desktop, đợi Engine running, chạy START_LISTINGSTUDIO.cmd. Địa chỉ web được lấy từ cấu hình của bản cài. STOP_LISTINGSTUDIO.cmd chỉ dừng các tiến trình có biên nhận đúng bản cài; giữ database và dữ liệu.

Máy có cấu hình cũ chưa có biên nhận: giữ nguyên `.env`, volume, dữ liệu và tiến trình đang chạy. Không chạy setup để tạo lại; nhờ người duy trì làm theo [TRANSFER_AND_RECOVERY](docs/onboarding/TRANSFER_AND_RECOVERY.md).

Không tự đăng hàng, mở bán, chạy lại batch hoặc cấp quyền shop khi khởi động. Lỗi có hướng dẫn trong [START_HERE](docs/onboarding/START_HERE.md); chẩn đoán bằng `npm run onboarding:check`.
