
export type RangeCondition<T> = ({
    compare_type: "at_least";
    value: number;
} & T) | ({
    compare_type: "at_most";
    value: number;
} & T) | ({
    compare_type: "between";
    min: number;
    max: number;
} & T) | ({
    compare_type: "exactly";
    value: number;
} & T);

export function evaluateRangeCondition(cnd: RangeCondition<{}>, value: number): boolean {
    if (cnd.compare_type === "at_least") return value >= cnd.value;
    if (cnd.compare_type === "at_most") return value <= cnd.value;
    if (cnd.compare_type === "exactly") return value === cnd.value;
    return value >= cnd.min && value <= cnd.max;
}

export interface MasteryLevelCondition {
    type: "mastery_level";
    options: RangeCondition<{
        champion: number
    }>;
}

export interface MasteryScoreCondition {
    type: "mastery_score";
    options: RangeCondition<{
        champion: number
    }>;
}

export interface TotalMasteryScoreCondition {
    type: "total_mastery_score";
    options: RangeCondition<{}>;
}

export interface RankedTierCondition {
    type: "ranked_tier";
    options: {
        compare_type: "higher" | "lower" | "equal";
        tier: number;
        queue: string;
    };
}

export interface ChampionPlayCountCondition {
    type: "champion_play_count";
    options: {
        count: number;
        champion: number;
    };
}

export interface ServerCondition {
    type: "server";
    options: {
        region: string;
    };
}

export type TypedRoleCondition =
    MasteryLevelCondition
    | MasteryScoreCondition
    | TotalMasteryScoreCondition
    | RankedTierCondition
    | ChampionPlayCountCondition
    | ServerCondition;

export type RoleCombinator = {
    type: "all"
} | {
    type: "any"
} | {
    type: "at_least",
    amount: number
};