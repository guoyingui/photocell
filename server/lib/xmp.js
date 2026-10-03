import path from 'node:path';
import { normalizeAnnotation, STAGES } from '../../shared/annotations.js';

const XML_LABELS = { none: '', red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple' };
const escapeXml = (value) => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function buildXmp(value, decision) {
  const entry = normalizeAnnotation(value);
  const keywords = [...new Set([...entry.keywords, `PhotoCull/${STAGES[entry.stage]}`])];
  return `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="PhotoCull">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pc="urn:photocull:ns:1.0/"
      xmp:Rating="${entry.rating}" xmp:Label="${XML_LABELS[entry.label]}" pc:Stage="${entry.stage}"${decision ? ` pc:FinalDecision="${escapeXml(decision)}"` : ''}>
      <dc:subject><rdf:Bag>${keywords.map((word) => `<rdf:li>${escapeXml(word)}</rdf:li>`).join('')}</rdf:Bag></dc:subject>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
`;
}

// 普通 ZIP（UTF-8 名称、stored），有总量限制；不依赖系统压缩命令。
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function zipFiles(files) {
  if (!files.length || files.length > 10000) throw Object.assign(new Error('每次导出 1–10000 个 XMP 文件'), { status: 400 });
  const local = [], central = [], names = new Set(); let offset = 0, centralSize = 0;
  for (const file of files) {
    const name = file.name.replaceAll('\\', '/');
    if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some((part) => !part || part === '..' || part === '.')
      || name.includes('\0') || names.has(name.toLocaleLowerCase())) {
      throw Object.assign(new Error('XMP 路径重复或不合法，请分批导出同主名的 RAW'), { status: 400 });
    }
    names.add(name.toLocaleLowerCase());
    const filename = Buffer.from(name), data = Buffer.from(file.body), crc = crc32(data);
    if (filename.length > 65535 || offset + data.length + filename.length + 30 > 64 * 1024 * 1024) {
      throw Object.assign(new Error('XMP 超过 64 MB，请缩小导出范围'), { status: 400 });
    }
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8); directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename); centralSize += directory.length + filename.length;
    offset += header.length + filename.length + data.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

export function xmpFiles(assets, annotations, finalMarks) {
  // 同一目录同主名的多种 RAW 共用一个 sidecar；保留目录，避免跨目录覆盖。
  const files = new Map();
  for (const asset of assets) for (const raw of asset.raws) {
    const name = path.posix.join(asset.dir.replaceAll('\\', '/'), path.parse(raw).name + '.xmp');
    files.set(name.toLocaleLowerCase(), { name, body: buildXmp(annotations[asset.id], finalMarks[asset.id]?.mark) });
  }
  return [...files.values()];
}
