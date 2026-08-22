export interface UsageTotals {
  views: number;
  visitors: number;
  countries: number;
  cities: number;
  activeDays: number;
}

export interface UsageCountryRow {
  code: string;
  name: string;
  flag: string;
  views: number;
  visitors: number;
  share: number;
}

export interface UsageCityRow {
  countryCode: string;
  countryName: string;
  region: string;
  city: string;
  views: number;
  visitors: number;
}

export interface UsagePathRow {
  path: string;
  views: number;
}

export interface UsageDayRow {
  day: string;
  views: number;
  visitors: number;
}

export interface UsageReport {
  rangeDays: number;
  startDay: string;
  endDay: string;
  firstRecordedDay: string | null;
  totals: UsageTotals;
  countries: UsageCountryRow[];
  cities: UsageCityRow[];
  paths: UsagePathRow[];
  daily: UsageDayRow[];
}
