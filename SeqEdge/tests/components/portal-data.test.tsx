import { describe, expect, it, vi } from 'vitest';
import DataPage from '@/app/data/page';

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

import { redirect } from 'next/navigation';

describe('legacy data route', () => {
  it('redirects to the release files section on the overview page', () => {
    DataPage();
    expect(redirect).toHaveBeenCalledWith('/#data');
  });
});
