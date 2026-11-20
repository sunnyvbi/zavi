
import type {
  SchemaMap,
  OperatorDbResult,
  NewUsersInWindowResult,
  NewUsersFilter,
} from "@/services/tools/operator-db/types";

import type { CountRangeFilter, CountInRangeResult } from "@/services/tools/operator-db/types";
export type { CountRangeFilter, CountInRangeResult };

export type OperatorDbWindowExt = {
  query_new_bookings_in_window?(
    filter: NewUsersFilter,
    cfg: SchemaMap,
  ): Promise<OperatorDbResult<NewUsersInWindowResult>>;
  query_new_users_in_range?(
    filter: CountRangeFilter,
    cfg: SchemaMap,
  ): Promise<OperatorDbResult<CountInRangeResult>>;
  query_new_bookings_in_range?(
    filter: CountRangeFilter,
    cfg: SchemaMap,
  ): Promise<OperatorDbResult<CountInRangeResult>>;
};
