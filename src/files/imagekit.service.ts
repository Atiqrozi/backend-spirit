import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import ImageKitPackage = require('imagekit');

type ImageKitConstructor = new (options: {
  publicKey?: string;
  privateKey: string;
  urlEndpoint?: string;
}) => InstanceType<typeof ImageKitPackage>;

@Injectable()
export class ImageKitService {
  private client() {
    const { IMAGEKIT_PRIVATE_KEY, IMAGEKIT_PUBLIC_KEY, IMAGEKIT_URL_ENDPOINT } = process.env;
    if (!IMAGEKIT_PRIVATE_KEY || !IMAGEKIT_PUBLIC_KEY || !IMAGEKIT_URL_ENDPOINT) {
      throw new ServiceUnavailableException('ImageKit belum dikonfigurasi dengan lengkap');
    }

    // Support both CommonJS exports and packages exposing the constructor as `default`.
    const exported = ImageKitPackage as unknown as { default?: ImageKitConstructor } & ImageKitConstructor;
    const ImageKitConstructorValue = exported.default ?? exported;
    return new ImageKitConstructorValue({
      publicKey: IMAGEKIT_PUBLIC_KEY,
      privateKey: IMAGEKIT_PRIVATE_KEY,
      urlEndpoint: IMAGEKIT_URL_ENDPOINT,
    });
  }

  upload(file: Buffer, fileName: string, folder: string, privateFile = false): Promise<any> {
    return this.client().upload({ file, fileName, folder, useUniqueFileName: true, ...(privateFile ? { isPrivateFile: true } : {}) });
  }

  delete(fileId: string): Promise<any> {
    return this.client().deleteFile(fileId);
  }

  createSignedUrl(path: string, expireSeconds = 300): string {
    return this.client().url({ path, signed: true, expireSeconds });
  }
}
