from pydantic import BaseModel
from typing import List, Optional, Dict

class Candidate(BaseModel):
    candidate_id: str
    name: Optional[str] = None
    office: Optional[str] = None
    party: Optional[str] = None
    state: Optional[str] = None
    district: Optional[str] = None

class SearchResponse(BaseModel):
    source: str
    results: List[Candidate]

class TotalsResponse(BaseModel):
    source: str
    cycle: int
    candidate_id: str
    coverage_end_date: Optional[str] = None
    receipts: int
    cash_on_hand: int
    breakdown: Dict[str, int]

class PacRow(BaseModel):
    donor_committee_id: str
    donor_name: Optional[str] = None
    total_amount: int

class PacResponse(BaseModel):
    source: str
    cycle: int
    candidate_id: str
    raw_snapshot_saved: bool
    pacs: List[PacRow]

class RefreshRequest(BaseModel):
    cycle: int
    candidate_ids: List[str]
