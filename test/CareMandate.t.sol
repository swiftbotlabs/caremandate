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

    function setUp() public {
        vm.warp(1_800_000_000);
        c = new CareMandate();
        mum = vm.addr(mumKey);
        vm.prank(family);
        id = c.createMandate(fagent, agency, mum, 45_000_000, 3);
    }

    function _post(uint64 t, bytes32 r) internal returns (uint256 v) { vm.prank(agency); v = c.postVisit(id, t, 45_000_000, r); }
    function _confirm(uint256 v, bool ok, uint256 key) internal {
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(key, c.confirmDigest(v, ok));
        vm.prank(fagent); c.confirmBySig(v, ok, vv, r, s);
    }
    function _status(uint256 v) internal view returns (CareMandate.Status st) { (,,, st,,) = c.visits(v); }

    function test_confirmedVisitIsPaidOnce() public {
        uint256 v = _post(uint64(block.timestamp - 1 hours), keccak256("tue"));
        _confirm(v, true, mumKey);
        vm.prank(fagent); c.markPaid(v, keccak256("hsp-flow-1"));
        assertEq(uint8(_status(v)), uint8(CareMandate.Status.Paid));
        vm.prank(fagent); vm.expectRevert(CareMandate.BadState.selector); c.markPaid(v, keccak256("hsp-flow-2"));
    }

    function test_unconfirmedVisitNeverPaid() public {
        uint256 v = _post(uint64(block.timestamp - 1 hours), keccak256("wed"));
        vm.prank(fagent); vm.expectRevert(CareMandate.BadState.selector); c.markPaid(v, keccak256("x"));
    }

    function test_missedVisitRejectedNeverPaid() public {
        uint256 v = _post(uint64(block.timestamp - 1 hours), keccak256("thu"));
        _confirm(v, false, mumKey);
        assertEq(uint8(_status(v)), uint8(CareMandate.Status.Rejected));
        vm.prank(fagent); vm.expectRevert(CareMandate.BadState.selector); c.markPaid(v, keccak256("x"));
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
        vm.prank(fagent); vm.expectRevert(CareMandate.BadState.selector); c.markPaid(v4, keccak256("x"));
        vm.prank(agency); vm.expectRevert(CareMandate.NotAllowed.selector); c.approveExtra(v4);
        vm.prank(family); c.approveExtra(v4);
        vm.prank(fagent); c.markPaid(v4, keccak256("hsp-4"));
        assertEq(uint8(_status(v4)), uint8(CareMandate.Status.Paid));
    }

    function test_overCapAndReplayedReceiptRefused() public {
        vm.prank(agency); vm.expectRevert(CareMandate.BadInput.selector); c.postVisit(id, uint64(block.timestamp), 45_000_001, keccak256("big"));
        _post(uint64(block.timestamp), keccak256("same"));
        vm.prank(agency); vm.expectRevert(CareMandate.BadInput.selector); c.postVisit(id, uint64(block.timestamp), 1, keccak256("same"));
    }

    function test_onlyAgencyPostsOnlyFamilyAgentPaysOnlyFamilyEdits() public {
        vm.prank(fagent); vm.expectRevert(CareMandate.NotAllowed.selector); c.postVisit(id, uint64(block.timestamp), 1, keccak256("a"));
        uint256 v = _post(uint64(block.timestamp), keccak256("b")); _confirm(v, true, mumKey);
        vm.prank(agency); vm.expectRevert(CareMandate.NotAllowed.selector); c.markPaid(v, keccak256("x"));
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
        vm.prank(family); c.updateMandate(id, 45_000_000, 3, false);
        vm.prank(agency); vm.expectRevert(CareMandate.BadState.selector); c.postVisit(id, uint64(block.timestamp), 1, keccak256("p"));
    }
}
