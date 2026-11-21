// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CareMandate
/// @notice A family's rules for paying a home carer per visit, and the record of every visit.
///         The carer agency's agent posts a visit; the person cared for confirms it (a signature from their own page key,
///         relayed by the family agent, so they never need gas); the family agent then pays that one visit through HSP and
///         records the HSP payment reference here. A visit that was not confirmed can never be marked paid, and a visit over
///         the weekly limit waits for the family. No money is held by this contract: HSP moves the money.
contract CareMandate {
    enum Status { None, Posted, Confirmed, Held, Paid, Rejected }

    struct Mandate {
        address family;      // sets the rules, approves extra visits, can pause
        address familyAgent; // relays confirmations and records payments
        address agency;      // the care agency's agent: posts visits, is the HSP merchant
        address confirmer;   // the cared-for person's page key: confirms visits by signature
        uint96 perVisitCap;  // max amount per visit, in the payment token's smallest unit
        uint8 weeklyMax;     // visits per week paid without asking the family
        bool active;
    }

    struct Visit {
        uint64 mandateId;
        uint64 visitTime;    // unix seconds, start of the visit
        uint96 amount;
        Status status;
        bytes32 receiptHash; // hash of the agency's visit receipt (who, when, what was done)
        bytes32 paymentRef;  // HSP payment request id / flow id hash, set when paid
    }

    uint256 public constant CONFIRM_WINDOW = 3 days;
    bytes32 public constant CONFIRM_TYPEHASH = keccak256("Confirm(uint256 visitId,bool happened)");
    bytes32 public immutable DOMAIN_SEPARATOR;

    uint64 public mandateCount;
    uint256 public visitCount;
    mapping(uint64 => Mandate) public mandates;
    mapping(uint256 => Visit) public visits;
    mapping(bytes32 => bool) public receiptUsed;
    mapping(uint64 => mapping(uint64 => uint8)) public counted; // mandateId => week => visits confirmed within the limit

    event MandateCreated(uint64 indexed mandateId, address indexed family, address indexed agency, address familyAgent, address confirmer, uint96 perVisitCap, uint8 weeklyMax);
    event MandateUpdated(uint64 indexed mandateId, uint96 perVisitCap, uint8 weeklyMax, bool active);
    event VisitPosted(uint256 indexed visitId, uint64 indexed mandateId, uint64 visitTime, uint96 amount, bytes32 receiptHash);
    event VisitConfirmed(uint256 indexed visitId, uint64 indexed mandateId);
    event VisitHeld(uint256 indexed visitId, uint64 indexed mandateId, uint64 week);
    event VisitRejected(uint256 indexed visitId, uint64 indexed mandateId);
    event ExtraApproved(uint256 indexed visitId);
    event VisitPaid(uint256 indexed visitId, uint64 indexed mandateId, uint96 amount, bytes32 paymentRef);

    error NotAllowed();
    error BadState();
    error BadInput();

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("CareMandate"), keccak256("1"), block.chainid, address(this)));
    }

    function createMandate(address familyAgent, address agency, address confirmer, uint96 perVisitCap, uint8 weeklyMax)
        external returns (uint64 id)
    {
        if (agency == address(0) || confirmer == address(0) || familyAgent == address(0) || perVisitCap == 0 || weeklyMax == 0) revert BadInput();
        id = ++mandateCount;
        mandates[id] = Mandate(msg.sender, familyAgent, agency, confirmer, perVisitCap, weeklyMax, true);
        emit MandateCreated(id, msg.sender, agency, familyAgent, confirmer, perVisitCap, weeklyMax);
    }

    function updateMandate(uint64 id, uint96 perVisitCap, uint8 weeklyMax, bool active) external {
        Mandate storage m = mandates[id];
        if (msg.sender != m.family) revert NotAllowed();
        if (perVisitCap == 0 || weeklyMax == 0) revert BadInput();
        (m.perVisitCap, m.weeklyMax, m.active) = (perVisitCap, weeklyMax, active);
        emit MandateUpdated(id, perVisitCap, weeklyMax, active);
    }

    /// @notice The agency's agent reports one visit.
    function postVisit(uint64 mandateId, uint64 visitTime, uint96 amount, bytes32 receiptHash) external returns (uint256 visitId) {
        Mandate storage m = mandates[mandateId];
        if (msg.sender != m.agency) revert NotAllowed();
        if (!m.active) revert BadState();
        if (amount == 0 || amount > m.perVisitCap || receiptHash == bytes32(0) || receiptUsed[receiptHash]) revert BadInput();
        if (visitTime > block.timestamp || block.timestamp - visitTime > CONFIRM_WINDOW) revert BadInput();
        receiptUsed[receiptHash] = true;
        visitId = ++visitCount;
        visits[visitId] = Visit(mandateId, visitTime, amount, Status.Posted, receiptHash, bytes32(0));
        emit VisitPosted(visitId, mandateId, visitTime, amount, receiptHash);
    }

    /// @notice The cared-for person's answer, signed with their page key and relayed by anyone (the family agent pays the gas).
    function confirmBySig(uint256 visitId, bool happened, uint8 v, bytes32 r, bytes32 s) external {
        Visit storage vi = visits[visitId];
        if (vi.status != Status.Posted) revert BadState();
        Mandate storage m = mandates[vi.mandateId];
        if (block.timestamp > vi.visitTime + CONFIRM_WINDOW) revert BadState();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(CONFIRM_TYPEHASH, visitId, happened))));
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != m.confirmer) revert NotAllowed();
        if (!happened) { vi.status = Status.Rejected; emit VisitRejected(visitId, vi.mandateId); return; }
        uint64 week = vi.visitTime / 1 weeks;
        if (counted[vi.mandateId][week] >= m.weeklyMax) { vi.status = Status.Held; emit VisitHeld(visitId, vi.mandateId, week); return; }
        counted[vi.mandateId][week] += 1;
        vi.status = Status.Confirmed;
        emit VisitConfirmed(visitId, vi.mandateId);
    }

    /// @notice The family lets a visit over the weekly limit be paid.
    function approveExtra(uint256 visitId) external {
        Visit storage vi = visits[visitId];
        if (msg.sender != mandates[vi.mandateId].family) revert NotAllowed();
        if (vi.status != Status.Held) revert BadState();
        vi.status = Status.Confirmed;
        emit ExtraApproved(visitId);
        emit VisitConfirmed(visitId, vi.mandateId);
    }

    /// @notice The family agent records the HSP payment for one confirmed visit. Once only.
    function markPaid(uint256 visitId, bytes32 paymentRef) external {
        Visit storage vi = visits[visitId];
        if (msg.sender != mandates[vi.mandateId].familyAgent) revert NotAllowed();
        if (vi.status != Status.Confirmed) revert BadState();
        if (paymentRef == bytes32(0)) revert BadInput();
        vi.status = Status.Paid;
        vi.paymentRef = paymentRef;
        emit VisitPaid(visitId, vi.mandateId, vi.amount, paymentRef);
    }

    function confirmDigest(uint256 visitId, bool happened) external view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(CONFIRM_TYPEHASH, visitId, happened))));
    }
}
