export class CampaignFilingOutcomeUnknown extends Error {
  constructor() {
    super("Your campaign proposal may have been saved, but its confirmation was lost. Check the channel's review cards before submitting another request.");
    this.name = "CampaignFilingOutcomeUnknown";
  }
}
