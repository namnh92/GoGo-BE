import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../shared/app-error';
import type { SubmissionPhotosService } from '../application/submission-photos.service';
import {
  CommunityPhotoController,
  SubmissionPhotoController,
} from './submission-photos.controller';

for (const { Controller, method, code } of [
  {
    Controller: SubmissionPhotoController,
    method: 'readForReview',
    code: 'SUBMISSION_PHOTO_NOT_FOUND',
  },
  { Controller: CommunityPhotoController, method: 'readPublic', code: 'PLACE_PHOTO_NOT_FOUND' },
] as const) {
  describe(Controller.name, () => {
    it('sets the binary content type after a successful read', async () => {
      const body = Buffer.from('photo');
      const read = vi.fn().mockResolvedValue(body);
      const controller = new Controller({ [method]: read } as unknown as SubmissionPhotosService);
      const type = vi.fn();
      const reply = { type } as unknown as FastifyReply;

      expect(await controller.content('place-or-submission', 'photo', reply)).toBe(body);
      expect(read).toHaveBeenCalledWith('place-or-submission', 'photo');
      expect(type).toHaveBeenCalledWith('image/webp');
      expect(read.mock.invocationCallOrder[0]).toBeLessThan(type.mock.invocationCallOrder[0]!);
    });

    it('propagates missing-photo errors without setting a binary content type', async () => {
      const error = AppError.notFound(code, 'Photo not found');
      const read = vi.fn().mockRejectedValue(error);
      const controller = new Controller({ [method]: read } as unknown as SubmissionPhotosService);
      const type = vi.fn();
      const reply = { type } as unknown as FastifyReply;

      await expect(controller.content('place-or-submission', 'photo', reply)).rejects.toBe(error);
      expect(type).not.toHaveBeenCalled();
    });
  });
}
