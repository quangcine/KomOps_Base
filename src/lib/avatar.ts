// Thu nhỏ và nén ảnh đại diện TRƯỚC KHI lưu. VÌ SAO BẮT BUỘC NÉN: ảnh đại diện lưu thẳng vào cột
// `profiles.avatar_url` dạng chuỗi nhúng. Mọi truy vấn đọc hồ sơ sau đó đều kéo theo bằng ấy dữ liệu, kể cả những chỗ
// chỉ cần cái tên. 256px là đủ: chỗ to nhất hiện ảnh này là vòng tròn 56px trên tab Tài khoản, nhân đôi cho màn
// hình nét cao vẫn còn dư.
const SIDE = 256;
const QUALITY = 0.82;

export async function compressAvatar(file: File): Promise<string> {
  const image = await loadImage(file);
  const canvas = document.createElement("canvas");
  canvas.width = SIDE;
  canvas.height = SIDE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Trình duyệt không xử lý được ảnh này.");

  // Cắt vuông từ GIỮA ảnh rồi mới thu nhỏ. Thu thẳng ảnh chữ nhật vào khung vuông là bóp méo mặt người, mà đây đúng
  // là ảnh mặt người.
  const side = Math.min(image.width, image.height);
  const x = (image.width - side) / 2;
  const y = (image.height - side) / 2;
  ctx.drawImage(image, x, y, side, side, 0, 0, SIDE, SIDE);

  // Luôn ra JPEG, không giữ định dạng gốc: ảnh PNG chụp màn hình nén ra vẫn to gấp nhiều lần JPEG cùng kích thước,
  // mà ảnh đại diện thì không cần nền trong suốt.
  return canvas.toDataURL("image/jpeg", QUALITY);
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Không đọc được ảnh.")); };
    img.src = url;
  });
}
