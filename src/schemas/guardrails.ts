export type InjectionRisk = "low" | "medium" | "high";

export type InjectionAssessment = {
  detected: boolean;
  risk: InjectionRisk;
  categories: string[];
};
