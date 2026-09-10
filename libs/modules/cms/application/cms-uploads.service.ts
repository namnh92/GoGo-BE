import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type MediaConfig } from '../../shared/config';
import { writeAudit } from '../../shared/audit';
import { DB } from '../../shared/tokens';
import type { Db } from '@gogo/database';
import type { Actor } from '../../identity/domain/actor';
import { publicCatalogueUrl } from '../../shared/media-url';
import {
  UploadsService,
  type CMS_UPLOAD_PURPOSES,
  type UploadPurpose,
} from '../../uploads/application/uploads.service';

export type CmsUploadPurpose = (typeof CMS_UPLOAD_PURPOSES)[number];

/**
 * BE-CMS-G5 (#227) — the upload path the console did not have.
 *
 * `/v1/uploads` authorizes a presigned PUT for the **calling consumer**: the
 * key it returns is bound to that actor and to a purpose a mobile client
 * writes. An admin could not use it, so a banner — where the image is
 * mandatory — had nothing to bind to.
 *
 * This is the same pipeline, not a second one: the same presigner, the same
 * content-type allowlist, the same size ceiling, the same `media_uploads` row
 * that makes a key mean something. What differs is who may ask and what for,
 * plus the audit entry, because a staff upload is a staff action.
 */
@Injectable()
export class CmsUploadsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly uploads: UploadsService,
    @Inject(APP_CONFIG) private readonly config: MediaConfig,
  ) {}

  async create(
    actor: Actor,
    input: { purpose: CmsUploadPurpose; contentType: string; contentLength: number },
  ) {
    const authorized = await this.uploads.createUpload(actor, {
      ...input,
      purpose: input.purpose as UploadPurpose,
    });

    // Who uploaded what, when. The bytes never cross the API, so this row is
    // the only record that ties an object in the bucket to a person.
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: actor.id,
      action: 'cms_upload.authorized',
      resourceType: 'media_upload',
      resourceId: authorized.id,
      diff: {
        purpose: input.purpose,
        contentType: input.contentType,
        contentLength: input.contentLength,
        storageKey: authorized.key,
      },
    });

    return {
      ...authorized,
      contentType: input.contentType,
      // Where the object will be readable once the client has PUT it. Null
      // until media hosting is configured — an honest absence beats a URL
      // that would 404, and the console can tell the two apart.
      readUrl: this.readUrl(authorized.key),
    };
  }

  private readUrl(key: string): string | null {
    return publicCatalogueUrl(this.config?.MEDIA_PUBLIC_BASE_URL, key);
  }
}
