/** 参考图预检：只看魔数判断服务端收不收（尺寸/合法性由服务端二次校验）。 */

export const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 认得就是 {format, ext, mime}，不认得返回 null（提示里用「PNG / JPEG / WebP」）。 */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  if (buf.subarray(0, 8).equals(PNG_SIG)) {
    return { format: 'png', ext: '.png', mime: 'image/png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { format: 'jpeg', ext: '.jpg', mime: 'image/jpeg' };
  }
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { format: 'webp', ext: '.webp', mime: 'image/webp' };
  }
  return null;
}
