import { describe, expect, it } from 'vitest';

import { parseNotificationRenderRequest } from './rendering.js';

describe('notification render request', () => {
  it('parses a bounded HTML image request', () => {
    expect(
      parseNotificationRenderRequest({
        renderer: 'html-image',
        html: '<main>Report</main>',
        format: 'webp',
        filename: 'report.webp',
        width: 1200,
        height: 1600,
        deviceScaleFactor: 2,
        quality: 85,
        fullPage: true,
        delivery: 'attachment',
        options: {
          waitUntil: 'networkidle',
        },
      }),
    ).toEqual({
      renderer: 'html-image',
      html: '<main>Report</main>',
      format: 'webp',
      filename: 'report.webp',
      width: 1200,
      height: 1600,
      deviceScaleFactor: 2,
      quality: 85,
      fullPage: true,
      delivery: 'attachment',
      options: {
        waitUntil: 'networkidle',
      },
    });
  });

  it('rejects invalid formats and oversized dimensions', () => {
    expect(() =>
      parseNotificationRenderRequest({
        renderer: 'html-image',
        html: '<main>Report</main>',
        format: 'gif',
      }),
    ).toThrow('unsupported notification image format');

    expect(() =>
      parseNotificationRenderRequest({
        renderer: 'html-image',
        html: '<main>Report</main>',
        width: 10000,
      }),
    ).toThrow('notification render width must be between 16 and 4096');
  });
});
