// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/CareMandate.sol";

contract CareMandateTest is Test {
    CareMandate c;
    address family = address(0xF1);
    address fagent = address(0xFA);
    address agency = address(0xA6);
    uint256 mumKey = 0xA11CE;
    address mum;
    uint64 id;
    // testnet scale: 1,000,000 won -> 719,424 raw USDC (1,390 KRW/USD at 1:1000), so a 45,000-won visit may cost at most 32,375 raw
    uint64 constant RATE = 719_424;
    uint96 constant PAID = 30_006;           // $0.03 quoted live by HSP (+0.02%)
    bytes32 constant STX = keccak256("settlement-tx");

    function setUp() public {
        vm.warp(1_800_000_000);
        c = new CareMandate();
        mum = vm.addr(mumKey);
        vm.prank(family);
        id = c.createMandate(fagent, agency, mum, 45_000, 3, RATE);
    }

    function _post(uint64 t, bytes32 r) internal returns (uint256 v) { vm.prank(agency); v = c.postVisit(id, t, 45_000, r); }
    function _confirm(uint256 v, bool ok, uint256 key) internal {
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(key, c.confirmDigest(v, ok));
        vm.prank(fagent); c.confirmBySig(v, ok, vv, r, s);
    }
    function _status(uint256 v) internal view returns (CareMandate.Status st) { (,,, st,,) = c.visits(v); }

    function test_confirmedVisitIsPaidOnce() public {
        uint256 v = _post(uint64(block.timestamp - 1 hours), keccak256("tue"));
        _confirm(v, true, mumKey);
        vm.prank(fagent); c.markPaid(v, keccak256("hsp-flow-1"), PAID, STX);
        assertEq(uint8(_status(v)), uint8(CareMandate.Status.Paid));
        vm.prank(fagent); vm.expectRevert(CareMandate.BadState.selector); c.markPaid(v, keccak256("hsp-flow-2"), PAID, STX);
    }

    function test_unconfirmedVisitNeverPaid() public {
        uint256 v = _post(uint64(block.timestamp - 1 hours), keccak256("wed"));
        vm.prank(fagent); vm.expectRevert(CareMandate.BadState.selector); c.markPaid(v, keccak256("x"), PAID, STX);
    }

    function test_missedVisitRejectedNeverPaid() public {
        uint256 v = _post(uint64(block.timestamp - 1 hours), keccak256("thu"));
        _confirm(v, false, mumKey);
        assertEq(uint8(_status(v)), uint8(CareMandate.Status.Rejected));
        vm.prank(fagent); vm.expectRevert(CareMandate.BadState.selector); c.markPaid(v, keccak256("x"), PAID, STX);
    }

    function test_strangerSignatureRefused() public {
        uint256 v = _post(uint64(block.timestamp - 1 hours), keccak256("fri"));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(0xBAD, c.confirmDigest(v, true));
        vm.expectRevert(CareMandate.NotAllowed.selector); c.confirmBySig(v, true, vv, r, s);
    }

    function test_fourthVisitInWeekHeldUntilFamilyApproves() public {
        uint64 t = uint64((block.timestamp / 1 weeks) * 1 weeks + 1 hours);
        vm.warp(t + 2 hours);
        for (uint256 i; i < 3; i++) { uint256 v = _post(t, keccak256(abi.encode(i))); _confirm(v, true, mumKey); }
        uint256 v4 = _post(t, keccak256("fourth"));
        _confirm(v4, true, mumKey);
        assertEq(uint8(_status(v4)), uint8(CareMandate.Status.Held));
        vm.prank(fagent); vm.expectRevert(CareMandate.BadState.selector); c.markPaid(v4, keccak256("x"), PAID, STX);
        vm.prank(agency); vm.expectRevert(CareMandate.NotAllowed.selector); c.approveExtra(v4);
        vm.prank(family); c.approveExtra(v4);
        vm.prank(fagent); c.markPaid(v4, keccak256("hsp-4"), PAID, STX);
        assertEq(uint8(_status(v4)), uint8(CareMandate.Status.Paid));
    }

    function test_overCapAndReplayedReceiptRefused() public {
        vm.prank(agency); vm.expectRevert(CareMandate.BadInput.selector); c.postVisit(id, uint64(block.timestamp), 45_001, keccak256("big"));
        _post(uint64(block.timestamp), keccak256("same"));
        vm.prank(agency); vm.expectRevert(CareMandate.BadInput.selector); c.postVisit(id, uint64(block.timestamp), 1, keccak256("same"));
    }

    function test_onlyAgencyPostsOnlyFamilyAgentPaysOnlyFamilyEdits() public {
        vm.prank(fagent); vm.expectRevert(CareMandate.NotAllowed.selector); c.postVisit(id, uint64(block.timestamp), 1, keccak256("a"));
        uint256 v = _post(uint64(block.timestamp), keccak256("b")); _confirm(v, true, mumKey);
        vm.prank(agency); vm.expectRevert(CareMandate.NotAllowed.selector); c.markPaid(v, keccak256("x"), PAID, STX);
        vm.prank(agency); vm.expectRevert(CareMandate.NotAllowed.selector); c.updateMandate(id, 1, 1, true);
    }

    function test_lateConfirmationAndFutureVisitRefused() public {
        uint256 v = _post(uint64(block.timestamp), keccak256("late"));
        vm.warp(block.timestamp + 3 days + 1);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(mumKey, c.confirmDigest(v, true));
        vm.expectRevert(CareMandate.BadState.selector); c.confirmBySig(v, true, vv, r, s);
        vm.prank(agency); vm.expectRevert(CareMandate.BadInput.selector); c.postVisit(id, uint64(block.timestamp + 1 hours), 1, keccak256("future"));
    }

    function test_pausedMandateTakesNoVisits() public {
        vm.prank(family); c.updateMandate(id, 45_000, 3, false);
        vm.prank(agency); vm.expectRevert(CareMandate.BadState.selector); c.postVisit(id, uint64(block.timestamp), 1, keccak256("p"));
    }

    function _paidVisit(bytes32 r) internal returns (uint256 v) {
        v = _post(uint64(block.timestamp - 1 hours), r); _confirm(v, true, mumKey);
    }

    function test_capConversionAndOverMandatePaymentRefused() public {
        uint256 v = _paidVisit(keccak256("fx"));
        assertEq(c.maxPayRaw(v), 32_375);                       // ceil(45,000 * 719,424 / 1e6)
        uint96 limit = 33_993;                                  // floor(32,375 x 1.05): + 5% FX allowance
        vm.prank(fagent); vm.expectRevert(CareMandate.OverMandate.selector); c.markPaid(v, keccak256("f"), limit + 1, STX);
        vm.prank(fagent); vm.expectRevert(CareMandate.BadInput.selector); c.markPaid(v, keccak256("f"), 0, STX);
        vm.prank(fagent); c.markPaid(v, keccak256("f"), limit, STX);
        (uint96 paid, bytes32 tx_,, bool ack) = c.payments(v);
        assertEq(paid, limit); assertEq(tx_, STX); assertFalse(ack);
    }

    function test_overCapVisitCannotBePosted() public {
        vm.prank(agency); vm.expectRevert(CareMandate.BadInput.selector); c.postVisit(id, uint64(block.timestamp), 46_000, keccak256("46k"));
        assertEq(c.visitCount(), 0);
    }

    function test_zeroRateRefused() public {
        vm.prank(family); vm.expectRevert(CareMandate.BadInput.selector); c.createMandate(fagent, agency, mum, 45_000, 3, 0);
    }

    function test_paymentIssueKeepsVisitConfirmedUnpaidThenPaysOnce() public {
        uint256 v = _paidVisit(keccak256("issue"));
        vm.prank(agency); vm.expectRevert(CareMandate.NotAllowed.selector); c.notePaymentIssue(v, keccak256("f1"), CareMandate.Issue.HspPaymentFailed);
        vm.prank(fagent); vm.expectRevert(CareMandate.BadInput.selector); c.notePaymentIssue(v, keccak256("f1"), CareMandate.Issue.None);
        vm.prank(fagent); c.notePaymentIssue(v, keccak256("f1"), CareMandate.Issue.HspPaymentFailed);
        vm.prank(fagent); c.notePaymentIssue(v, keccak256("f2"), CareMandate.Issue.Unsettled);
        assertEq(uint8(_status(v)), uint8(CareMandate.Status.Confirmed));
        (,, uint8 n,) = c.payments(v); assertEq(n, 2);
        vm.prank(fagent); c.markPaid(v, keccak256("f2"), PAID, STX);
        vm.prank(fagent); vm.expectRevert(CareMandate.BadState.selector); c.markPaid(v, keccak256("f3"), PAID, STX);
        vm.prank(fagent); vm.expectRevert(CareMandate.BadState.selector); c.notePaymentIssue(v, keccak256("f3"), CareMandate.Issue.Unsettled);
    }

    function test_onlyAgencyAcksOncePaidOnce() public {
        uint256 v = _paidVisit(keccak256("ack"));
        vm.prank(agency); vm.expectRevert(CareMandate.BadState.selector); c.ackPaid(v);           // not paid yet
        vm.prank(fagent); c.markPaid(v, keccak256("f"), PAID, STX);
        vm.prank(fagent); vm.expectRevert(CareMandate.NotAllowed.selector); c.ackPaid(v);
        vm.prank(agency); c.ackPaid(v);
        (,,, bool ack) = c.payments(v); assertTrue(ack);
        vm.prank(agency); vm.expectRevert(CareMandate.BadState.selector); c.ackPaid(v);
    }

    function test_mockRunWithoutSettlementTxCannotBeAcked() public {
        uint256 v = _paidVisit(keccak256("mock"));
        vm.prank(fagent); c.markPaid(v, keccak256("MOCK"), PAID, bytes32(0));
        vm.prank(agency); vm.expectRevert(CareMandate.BadState.selector); c.ackPaid(v);
    }
}
