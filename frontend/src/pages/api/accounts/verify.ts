import type { NextApiRequest, NextApiResponse } from 'next';
import { ApiResponse } from '@shared/types';
import { prisma } from '../../../lib/prisma';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse<any>>
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({
      success: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} Not Allowed` },
      timestamp: new Date().toISOString(),
    });
  }

  const { accountId, li_at, JSESSIONID } = req.body || {};

  let cookieLiAt = li_at;
  let cookieJsession = JSESSIONID;

  if (accountId && (!cookieLiAt || !cookieJsession)) {
    const account = await prisma.linkedInAccount.findUnique({ where: { id: accountId } });
    if (account && account.cookies) {
      const c = account.cookies as Record<string, string>;
      cookieLiAt = cookieLiAt || c.li_at;
      cookieJsession = cookieJsession || c.JSESSIONID;
    }
  }

  cookieLiAt = (cookieLiAt || '').trim().replace(/^['"]+|['"]+$/g, '');
  cookieJsession = (cookieJsession || '').trim().replace(/^['"]+|['"]+$/g, '');

  if (!cookieLiAt || cookieLiAt.length < 50) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_COOKIE',
        message: "The 'li_at' cookie must be at least 50 characters long (real LinkedIn tokens start with 'AQED...' and are ~150 chars).",
      },
      timestamp: new Date().toISOString(),
    });
  }

  const csrfToken = cookieJsession.replace(/"/g, '');

  try {
    const testUrl = 'https://www.linkedin.com/voyager/api/me';
    const response = await fetch(testUrl, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/vnd.linkedin.normalized+json+2.1',
        'x-li-lang': 'en_US',
        'x-restli-protocol-version': '2.0.0',
        'csrf-token': csrfToken,
        'Cookie': `li_at=${cookieLiAt}; JSESSIONID="${csrfToken}"`,
      },
      redirect: 'manual',
    });

    if (response.status === 200) {
      const data = await response.json();
      const plainId = data.plainId;
      const publicId = data.publicIdentifier;

      // Update account in database if accountId provided
      if (accountId) {
        await prisma.linkedInAccount.update({
          where: { id: accountId },
          data: {
            publicIdentifier: publicId || undefined,
            linkedinId: plainId ? String(plainId) : undefined,
          },
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          verified: true,
          status: 200,
          publicIdentifier: publicId,
          plainId,
          message: 'LinkedIn session successfully verified! Account is live and authorized.',
        },
        timestamp: new Date().toISOString(),
      });
    }

    if (response.status === 401 || response.status === 302) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message:
            "LinkedIn returned 401 Unauthorized. This 'li_at' cookie is expired or invalidated by LinkedIn. Please log into linkedin.com in your browser, press F12, and copy a fresh 'li_at' cookie.",
        },
        timestamp: new Date().toISOString(),
      });
    }

    return res.status(response.status).json({
      success: false,
      error: {
        code: `HTTP_${response.status}`,
        message: `LinkedIn returned status ${response.status}`,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'NETWORK_ERROR', message: `Failed to contact LinkedIn: ${err.message}` },
      timestamp: new Date().toISOString(),
    });
  }
}
