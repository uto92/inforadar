export interface StationRef {
  line: number;
  station: number;
}

export declare const STATIONS: Record<
  "osaka" | "kyobashi" | "tennoji" | "shinimamiya" | "takatsuki" | "umeda_metro" | "namba_metro" | "unmapped",
  StationRef
>;
export declare const REGION_KINKI: number;
export declare const PROC: { fare: number; charge: number; retail: number };
export declare const BLANK_BLOCK: string;

export declare function encodeHistoryBlock(params: {
  terminalType?: number;
  procType: number;
  paymentType?: number;
  entryExitType?: number;
  date: Date;
  entry?: StationRef | null;
  exit?: StationRef | null;
  balance: number;
  seq: number;
  region?: number;
}): string;

export declare function buildMockHistory(params?: {
  records?: number;
  startSeq?: number;
  startBalance?: number;
  startDate?: Date;
  blankCount?: number | null;
}): string[];
