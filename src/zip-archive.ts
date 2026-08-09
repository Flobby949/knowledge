interface ZipEntry {
  name: string;
  data: Buffer;
}

export function createZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);

    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);

    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + entry.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);

  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function readStoredZip(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;

  while (offset + 4 <= archive.length) {
    const signature = archive.readUInt32LE(offset);

    if (signature !== 0x04034b50) {
      break;
    }

    if (offset + 30 > archive.length) {
      throw new Error("ZIP local header is truncated");
    }

    const method = archive.readUInt16LE(offset + 8);
    const checksum = archive.readUInt32LE(offset + 14);
    const dataLength = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + dataLength;

    if (method !== 0 || dataEnd > archive.length) {
      throw new Error("ZIP entry is unsupported or truncated");
    }

    const name = archive.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const data = Buffer.from(archive.subarray(dataStart, dataEnd));

    if (entries.has(name) || crc32(data) !== checksum) {
      throw new Error("ZIP entry is duplicated or has an invalid checksum");
    }

    entries.set(name, data);
    offset = dataEnd;
  }

  if (entries.size === 0) {
    throw new Error("ZIP does not contain stored entries");
  }

  return entries;
}

function crc32(data: Buffer): number {
  let value = 0xffffffff;

  for (const byte of data) {
    value ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }

  return (value ^ 0xffffffff) >>> 0;
}
