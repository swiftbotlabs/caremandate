// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice TEST ONLY. A minimal EIP-3009 token with USDC's EIP-712 domain ("USD Coin", "2"), for the OFFLINE end-to-end run:
///         installed with anvil_setCode at the HSK-testnet USDC address HSP's chain config names, so the local mock HSP gateway
///         settles a real transferWithAuthorization on the local chain. Public mint: never deploy outside a local test chain.
contract MockEIP3009 {
    string public constant name = "USD Coin";
    string public constant version = "2";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    uint256 public totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this)));
    }

    function mint(address to, uint256 v) external { balanceOf[to] += v; totalSupply += v; emit Transfer(address(0), to, v); }

    function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce,
        uint8 v, bytes32 r, bytes32 s) external
    {
        require(block.timestamp > validAfter && block.timestamp < validBefore, "auth window");
        require(!authorizationState[from][nonce], "auth used");
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(),
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))));
        address who = ecrecover(d, v, r, s);
        require(who != address(0) && who == from, "bad signature");
        authorizationState[from][nonce] = true;
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value; balanceOf[to] += value;
        emit AuthorizationUsed(from, nonce);
        emit Transfer(from, to, value);
    }
}
