import type { NextApiRequest, NextApiResponse } from 'next';
import { ApiResponse } from '@shared/types';
import { prisma } from '../../../lib/prisma';
import { randomUUID } from 'crypto';
import { z } from 'zod';

const createAccountSchema = z.object({
  email: z.string().email('Valid email is required'),
  name: z.string().optional(),
  linkedinId: z.string().optional(),
  publicIdentifier: z.string().optional(),
  cookies: z
    .object({
      li_at: z.string().optional(),
      JSESSIONID: z.string().optional(),
    })
    .optional(),
  hourlyActionLimit: z.number().int().default(15),
  dailyActionLimit: z.number().int().default(60),
});

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse<any>>
) {
  if (req.method === 'GET') {
    let accounts = await prisma.linkedInAccount.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        assignedProxy: {
          select: { id: true, host: true, port: true, countryCode: true, status: true },
        },
      },
    });

    // Auto-seed sample managed accounts if database is empty so dashboard works immediately out of the box
    if (accounts.length === 0) {
      await prisma.linkedInAccount.createMany({
        data: [
          {
            id: randomUUID(),
            email: 'enterprise-lead-1@company.com',
            name: 'Sarah Connor (Executive Sales)',
            status: 'ACTIVE',
            hourlyActionLimit: 20,
            dailyActionLimit: 60,
            cookies: {}, // Initially empty so user can see "Missing li_at" or configure real cookie
          },
          {
            id: randomUUID(),
            email: 'recruiter-east@company.com',
            name: 'John Miller (Talent Acquisition)',
            status: 'ACTIVE',
            hourlyActionLimit: 15,
            dailyActionLimit: 40,
            cookies: {},
          },
        ],
      });

      accounts = await prisma.linkedInAccount.findMany({
        orderBy: { createdAt: 'asc' },
        include: { assignedProxy: true },
      });
    }

    return res.status(200).json({
      success: true,
      data: accounts.map((acc) => {
        const cookies = (acc.cookies as Record<string, string>) || {};
        const hasLiAt = Boolean(cookies.li_at && cookies.li_at.trim().length > 0);
        return {
          id: acc.id,
          email: acc.email,
          name: acc.name,
          status: acc.status,
          hasAuthorizedSession: hasLiAt,
          sessionStatus: hasLiAt ? 'AUTHORIZED' : 'MISSING_SESSION_COOKIE',
          hourlyActionLimit: acc.hourlyActionLimit,
          dailyActionLimit: acc.dailyActionLimit,
          hourlyConnectionLimit: acc.hourlyConnectionLimit,
          dailyConnectionLimit: acc.dailyConnectionLimit,
          hourlyMessageLimit: acc.hourlyMessageLimit,
          dailyMessageLimit: acc.dailyMessageLimit,
          lastActionTimestamp: acc.lastActionTimestamp,
          assignedProxy: acc.assignedProxy,
          createdAt: acc.createdAt,
          updatedAt: acc.updatedAt,
        };
      }),
      timestamp: new Date().toISOString(),
    });
  }

  if (req.method === 'POST') {
    const parseResult = createAccountSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', '),
        },
        timestamp: new Date().toISOString(),
      });
    }

    const { email, name, linkedinId, publicIdentifier, cookies, hourlyActionLimit, dailyActionLimit } =
      parseResult.data;

    const account = await prisma.linkedInAccount.upsert({
      where: { email },
      update: {
        name,
        linkedinId,
        publicIdentifier,
        cookies: cookies as any,
        hourlyActionLimit,
        dailyActionLimit,
      },
      create: {
        id: randomUUID(),
        email,
        name,
        linkedinId,
        publicIdentifier,
        cookies: cookies as any,
        hourlyActionLimit,
        dailyActionLimit,
        status: 'ACTIVE',
      },
    });

    const hasLiAt = Boolean(cookies?.li_at && cookies.li_at.trim().length > 0);

    return res.status(201).json({
      success: true,
      data: {
        id: account.id,
        email: account.email,
        name: account.name,
        status: account.status,
        hasAuthorizedSession: hasLiAt,
        sessionStatus: hasLiAt ? 'AUTHORIZED' : 'MISSING_SESSION_COOKIE',
        createdAt: account.createdAt,
      },
      timestamp: new Date().toISOString(),
    });
  }

  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(405).json({
    success: false,
    error: { code: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} Not Allowed` },
    timestamp: new Date().toISOString(),
  });
}
