pragma solidity 0.4.24;

import { AragonApp } from "@aragon/os/contracts/apps/AragonApp.sol";
import { EtherTokenConstant } from "@aragon/os/contracts/common/EtherTokenConstant.sol";
import { IsContract } from "@aragon/os/contracts/common/IsContract.sol";
import { SafeERC20 } from "@aragon/os/contracts/common/SafeERC20.sol";
import { SafeMath } from "@aragon/os/contracts/lib/math/SafeMath.sol";
import { ERC20} from "@aragon/os/contracts/lib/token/ERC20.sol";
import { TokenManager } from "@aragon/apps-token-manager/contracts/TokenManager.sol";
import { Vault } from "@aragon/apps-vault/contracts/Vault.sol";
import { IBancorFormula } from "@ablack/fundraising-bancor-formula/contracts/interfaces/IBancorFormula.sol";
import { ApproveAndCallFallBack } from "@aragon/apps-shared-minime/contracts/MiniMeToken.sol";

contract AugmentedBondingCurve is EtherTokenConstant, IsContract, ApproveAndCallFallBack, AragonApp {
    using SafeERC20 for ERC20;
    using SafeMath  for uint256;

    /**
    Hardcoded constants to save gas
    bytes32 public constant UPDATE_FORMULA_ROLE                        = keccak256("UPDATE_FORMULA_ROLE");
    bytes32 public constant UPDATE_BENEFICIARY_ROLE                    = keccak256("UPDATE_BENEFICIARY_ROLE");
    bytes32 public constant UPDATE_FEES_ROLE                           = keccak256("UPDATE_FEES_ROLE");
    bytes32 public constant MANAGE_COLLATERAL_TOKEN_ROLE               = keccak256("MANAGE_COLLATERAL_TOKEN_ROLE");
    bytes32 public constant MAKE_BUY_ORDER_ROLE                        = keccak256("MAKE_BUY_ORDER_ROLE");
    bytes32 public constant MAKE_SELL_ORDER_ROLE                       = keccak256("MAKE_SELL_ORDER_ROLE");
    */
    bytes32 public constant UPDATE_FORMULA_ROLE                        = 0xbfb76d8d43f55efe58544ea32af187792a7bdb983850d8fed33478266eec3cbb;
    bytes32 public constant UPDATE_BENEFICIARY_ROLE                    = 0xf7ea2b80c7b6a2cab2c11d2290cb005c3748397358a25e17113658c83b732593;
    bytes32 public constant UPDATE_FEES_ROLE                           = 0x5f9be2932ed3a723f295a763be1804c7ebfd1a41c1348fb8bdf5be1c5cdca822;
    bytes32 public constant MANAGE_COLLATERAL_TOKEN_ROLE               = 0xd9d296b0bc78eaab1039dfb623e942381a5402711b7fcec0bfb94004c18879f4;
    bytes32 public constant MAKE_BUY_ORDER_ROLE                        = 0x0dfea6908176d96adbee7026b3fe9fbdaccfc17bc443ddf14734fd27c3136179;
    bytes32 public constant MAKE_SELL_ORDER_ROLE                       = 0x52e3ace6a83e0c810920056ccc32fed5aa1e86287545113b03a52ab5c84e3f66;

    uint256 public constant PCT_BASE = 10 ** 18; // 0% = 0; 1% = 10 ** 16; 100% = 10 ** 18
    uint32  public constant PPM      = 1000000;

    string private constant ERROR_CONTRACT_IS_EOA                = "MM_CONTRACT_IS_EOA";
    string private constant ERROR_INVALID_BENEFICIARY            = "MM_INVALID_BENEFICIARY";
    string private constant ERROR_INVALID_PERCENTAGE             = "MM_INVALID_PERCENTAGE";
    string private constant ERROR_INVALID_RESERVE_RATIO          = "MM_INVALID_RESERVE_RATIO";
    string private constant ERROR_INVALID_TM_SETTING             = "MM_INVALID_TM_SETTING";
    string private constant ERROR_INVALID_COLLATERAL             = "MM_INVALID_COLLATERAL";
    string private constant ERROR_INVALID_COLLATERAL_VALUE       = "MM_INVALID_COLLATERAL_VALUE";
    string private constant ERROR_INVALID_BOND_AMOUNT            = "MM_INVALID_BOND_AMOUNT";
    string private constant ERROR_COLLATERAL_ALREADY_WHITELISTED = "MM_COLLATERAL_ALREADY_WHITELISTED";
    string private constant ERROR_COLLATERAL_NOT_WHITELISTED     = "MM_COLLATERAL_NOT_WHITELISTED";
    string private constant ERROR_SLIPPAGE_EXCEEDS_LIMIT         = "MM_SLIPPAGE_EXCEEDS_LIMIT";
    string private constant ERROR_TRANSFER_FAILED                = "MM_TRANSFER_FAILED";
    string private constant ERROR_NOT_BUY_FUNCTION               = "MM_NOT_BUY_FUNCTION";
    string private constant ERROR_BUYER_NOT_FROM                 = "MM_BUYER_NOT_FROM";
    string private constant ERROR_COLLATERAL_NOT_SENDER          = "MM_COLLATERAL_NOT_SENDER";
    string private constant ERROR_DEPOSIT_NOT_AMOUNT             = "MM_DEPOSIT_NOT_AMOUNT";
    string private constant ERROR_NO_PERMISSION                  = "MM_NO_PERMISSION";
    string private constant ERROR_TOKEN_NOT_SENDER               = "MM_TOKEN_NOT_SENDER";
    string private constant ERROR_INVALID_BUY_ORDER_DATA         = "MM_INVALID_BUY_ORDER_DATA";

    struct Collateral {
        uint256 virtualSupply;
        uint256 virtualBalance;
        bool    whitelisted;
        uint32  reserveRatio;
    }

    TokenManager public tokenManager;
    ERC20 public token;
    Vault public reserve;
    address public beneficiary;
    IBancorFormula public formula;

    uint256 public buyFeePct;
    uint256 public sellFeePct;

    mapping(address => Collateral) public collaterals;

    event UpdateBeneficiary(address indexed beneficiary);
    event UpdateFormula(address indexed formula);
    event UpdateFees(uint256 buyFeePct, uint256 sellFeePct);
    event AddCollateralToken(
        address indexed collateral,
        uint256 virtualSupply,
        uint256 virtualBalance,
        uint32  reserveRatio
    );
    event RemoveCollateralToken(address indexed collateral);
    event UpdateCollateralToken(
        address indexed collateral,
        uint256 virtualSupply,
        uint256 virtualBalance,
        uint32  reserveRatio
    );
    event MakeBuyOrder(
        address indexed buyer,
        address indexed onBehalfOf,
        address indexed collateral,
        uint256 fee,
        uint256 purchaseAmount,
        uint256 returnedAmount,
        uint256 feePct
    );
    event MakeSellOrder(
        address indexed seller,
        address indexed onBehalfOf,
        address indexed collateral,
        uint256 fee,
        uint256 sellAmount,
        uint256 returnedAmount,
        uint256 feePct
    );

    /***** external function *****/

    /**
     * @notice Initialize market maker
     * @param _tokenManager The address of the [bonded token] token manager contract
     * @param _formula      The address of the BancorFormula [computation] contract
     * @param _reserve      The address of the reserve [pool] contract
     * @param _beneficiary  The address of the beneficiary [to whom fees are to be sent]
     * @param _buyFeePct    The fee to be deducted from buy orders [in PCT_BASE]
     * @param _sellFeePct   The fee to be deducted from sell orders [in PCT_BASE]
    */
    function initialize(
        TokenManager                 _tokenManager,
        IBancorFormula               _formula,
        Vault                        _reserve,
        address                      _beneficiary,
        uint256                      _buyFeePct,
        uint256                      _sellFeePct
    )
        external onlyInit
    {
        initialized();

        require(isContract(_tokenManager),                           ERROR_CONTRACT_IS_EOA);
        require(isContract(_formula),                                ERROR_CONTRACT_IS_EOA);
        require(isContract(_reserve),                                ERROR_CONTRACT_IS_EOA);
        require(_beneficiaryIsValid(_beneficiary),                   ERROR_INVALID_BENEFICIARY);
        require(_feeIsValid(_buyFeePct) && _feeIsValid(_sellFeePct), ERROR_INVALID_PERCENTAGE);
        require(_tokenManagerSettingIsValid(_tokenManager),          ERROR_INVALID_TM_SETTING);

        tokenManager = _tokenManager;
        token = ERC20(tokenManager.token());
        formula = _formula;
        reserve = _reserve;
        beneficiary = _beneficiary;
        buyFeePct = _buyFeePct;
        sellFeePct = _sellFeePct;
    }

    /* generic settings related function */

    /**
     * @notice Update formula to `_formula`
     * @param _formula The address of the new BancorFormula [computation] contract
    */
    function updateFormula(IBancorFormula _formula) external auth(UPDATE_FORMULA_ROLE) {
        require(isContract(_formula), ERROR_CONTRACT_IS_EOA);

        _updateFormula(_formula);
    }

    /**
     * @notice Update beneficiary to `_beneficiary`
     * @param _beneficiary The address of the new beneficiary [to whom fees are to be sent]
    */
    function updateBeneficiary(address _beneficiary) external auth(UPDATE_BENEFICIARY_ROLE) {
        require(_beneficiaryIsValid(_beneficiary), ERROR_INVALID_BENEFICIARY);

        _updateBeneficiary(_beneficiary);
    }

    /**
     * @notice Update fees deducted from buy and sell orders to respectively `@formatPct(_buyFeePct)`% and `@formatPct(_sellFeePct)`%
     * @param _buyFeePct  The new fee to be deducted from buy orders [in PCT_BASE]
     * @param _sellFeePct The new fee to be deducted from sell orders [in PCT_BASE]
    */
    function updateFees(uint256 _buyFeePct, uint256 _sellFeePct) external auth(UPDATE_FEES_ROLE) {
        require(_feeIsValid(_buyFeePct) && _feeIsValid(_sellFeePct), ERROR_INVALID_PERCENTAGE);

        _updateFees(_buyFeePct, _sellFeePct);
    }

    /* collateral tokens related functions */

    /**
     * @notice Add `_collateral.symbol(): string` as a whitelisted collateral token
     * @param _collateral     The address of the collateral token to be whitelisted
     * @param _virtualSupply  The virtual supply to be used for that collateral token [in wei]
     * @param _virtualBalance The virtual balance to be used for that collateral token [in wei]
     * @param _reserveRatio   The reserve ratio to be used for that collateral token [in PPM]
    */
    function addCollateralToken(address _collateral, uint256 _virtualSupply, uint256 _virtualBalance, uint32 _reserveRatio)
        external auth(MANAGE_COLLATERAL_TOKEN_ROLE)
    {
        require(_collateral == ETH || ERC20(_collateral).totalSupply() > 0, ERROR_INVALID_COLLATERAL);
        require(!_collateralIsWhitelisted(_collateral),                     ERROR_COLLATERAL_ALREADY_WHITELISTED);
        require(_reserveRatioIsValid(_reserveRatio),                        ERROR_INVALID_RESERVE_RATIO);

        _addCollateralToken(_collateral, _virtualSupply, _virtualBalance, _reserveRatio);
    }

    /**
      * @notice Remove `_collateral.symbol(): string` as a whitelisted collateral token
      * @param _collateral The address of the collateral token to be un-whitelisted
    */
    function removeCollateralToken(address _collateral) external auth(MANAGE_COLLATERAL_TOKEN_ROLE) {
        require(_collateralIsWhitelisted(_collateral), ERROR_COLLATERAL_NOT_WHITELISTED);

        _removeCollateralToken(_collateral);
    }

    /**
     * @notice Update `_collateral.symbol(): string` collateralization settings
     * @param _collateral     The address of the collateral token whose collateralization settings are to be updated
     * @param _virtualSupply  The new virtual supply to be used for that collateral token [in wei]
     * @param _virtualBalance The new virtual balance to be used for that collateral token [in wei]
     * @param _reserveRatio   The new reserve ratio to be used for that collateral token [in PPM]
    */
    function updateCollateralToken(address _collateral, uint256 _virtualSupply, uint256 _virtualBalance, uint32 _reserveRatio)
        external auth(MANAGE_COLLATERAL_TOKEN_ROLE)
    {
        require(_collateralIsWhitelisted(_collateral), ERROR_COLLATERAL_NOT_WHITELISTED);
        require(_reserveRatioIsValid(_reserveRatio),   ERROR_INVALID_RESERVE_RATIO);

        _updateCollateralToken(_collateral, _virtualSupply, _virtualBalance, _reserveRatio);
    }

    /* market making related functions */

    /**
     * @notice Make a buy order worth `@tokenAmount(_collateral, _depositAmount)` for atleast `@tokenAmount(self.token(): address, _minReturnAmountAfterFee)`
     * @param _onBehalfOf The address of the address who is going to receive the tokens
     * @param _collateral The address of the collateral token to be deposited
     * @param _depositAmount The amount of collateral token to be deposited
     * @param _minReturnAmountAfterFee The minimum amount of the returned bonded tokens
     */
    function makeBuyOrder(address _onBehalfOf, address _collateral, uint256 _depositAmount, uint256 _minReturnAmountAfterFee)
        external payable authP(MAKE_BUY_ORDER_ROLE, arr(msg.sender, _onBehalfOf))
    {
        _makeBuyOrder(msg.sender, _onBehalfOf, _collateral, _depositAmount, _minReturnAmountAfterFee);
    }

    /**
     * @notice Make a sell order worth `@tokenAmount(self.token(): address, _sellAmount)` for atleast `@tokenAmount(_collateral, _minReturnAmountAfterFee)`
     * @param _onBehalfOf The address of the account who is going to receive the tokens
     * @param _collateral The address of the collateral token to be returned
     * @param _sellAmount The amount of bonded token to be spent
     * @param _minReturnAmountAfterFee The minimum amount of the returned collateral tokens
    */
    function makeSellOrder(address _onBehalfOf, address _collateral, uint256 _sellAmount, uint256 _minReturnAmountAfterFee)
        external nonReentrant authP(MAKE_SELL_ORDER_ROLE, arr(msg.sender, _onBehalfOf))
    {
        require(_collateralIsWhitelisted(_collateral), ERROR_COLLATERAL_NOT_WHITELISTED);
        require(_bondAmountIsValid(msg.sender, _sellAmount), ERROR_INVALID_BOND_AMOUNT);

        uint256 collateralSupply = token.totalSupply().add(collaterals[_collateral].virtualSupply);
        uint256 collateralBalanceOfReserve = _balanceOf(address(reserve), _collateral).add(collaterals[_collateral].virtualBalance);
        uint32 reserveRatio = collaterals[_collateral].reserveRatio;
        uint256 returnAmount = formula.calculateSaleReturn(collateralSupply, collateralBalanceOfReserve, reserveRatio, _sellAmount);

        uint256 fee = returnAmount.mul(sellFeePct).div(PCT_BASE);
        uint256 returnAmountLessFee = returnAmount.sub(fee);

        require(returnAmountLessFee >= _minReturnAmountAfterFee, ERROR_SLIPPAGE_EXCEEDS_LIMIT);

        tokenManager.burn(msg.sender, _sellAmount);

        if (returnAmountLessFee > 0) {
            reserve.transfer(_collateral, _onBehalfOf, returnAmountLessFee);
        }
        if (fee > 0) {
            reserve.transfer(_collateral, beneficiary, fee);
        }

        emit MakeSellOrder(msg.sender, _onBehalfOf, _collateral, fee, _sellAmount, returnAmountLessFee, sellFeePct);
    }

    /**
     * @dev ApproveAndCallFallBack interface conformance
     * @param _from Token sender
     * @param _amount Token amount
     * @param _token Token that received approval
     * @param _buyOrderData Data for the below function call
     *      makeBuyOrder(address _onBehalfOf, address _collateral, uint256 _depositAmount, uint256 _minReturnAmountAfterFee)
    */
    function receiveApproval(address _from, uint256 _amount, address _token, bytes _buyOrderData) public {
        require(_token == msg.sender, ERROR_TOKEN_NOT_SENDER);
        require(canPerform(_from, MAKE_BUY_ORDER_ROLE, new uint256[](0)), ERROR_NO_PERMISSION);

        _makeBuyOrderRaw(_from, msg.sender, _amount, _buyOrderData);
    }

    /***** public view functions *****/

    function getCollateralToken(address _collateral) public view isInitialized returns (bool, uint256, uint256, uint32) {
        Collateral storage collateral = collaterals[_collateral];

        return (collateral.whitelisted, collateral.virtualSupply, collateral.virtualBalance, collateral.reserveRatio);
    }

    function getStaticPricePPM(uint256 _supply, uint256 _balance, uint32 _reserveRatio)
        public view isInitialized returns (uint256)
    {
        return uint256(PPM).mul(uint256(PPM)).mul(_balance).div(_supply.mul(uint256(_reserveRatio)));
    }

    /***** internal functions *****/

    /* check functions */

    function _balanceOf(address _who, address _token) internal view returns (uint256) {
        return _token == ETH ? _who.balance : ERC20(_token).staticBalanceOf(_who);
    }

    function _beneficiaryIsValid(address _beneficiary) internal pure returns (bool) {
        return _beneficiary != address(0);
    }

    function _feeIsValid(uint256 _fee) internal pure returns (bool) {
        return _fee < PCT_BASE;
    }

    function _reserveRatioIsValid(uint32 _reserveRatio) internal pure returns (bool) {
        return _reserveRatio <= PPM;
    }

    function _tokenManagerSettingIsValid(TokenManager _tokenManager) internal view returns (bool) {
        return _tokenManager.maxAccountTokens() == uint256(-1);
    }

    function _collateralValueIsValid(address _collateral, uint256 _value)
        internal view returns (bool)
    {
        if (_value == 0) {
            return false;
        }

        if (_collateral == ETH) {
            return msg.value == _value;
        }

        return msg.value == 0;
    }

    function _bondAmountIsValid(address _account, uint256 _amount) internal view returns (bool) {
        return _amount != 0 && tokenManager.spendableBalanceOf(_account) >= _amount;
    }

    function _collateralIsWhitelisted(address _collateral) internal view returns (bool) {
        return collaterals[_collateral].whitelisted;
    }

    /* state modifiying functions */

    /**
     * @dev Make a buy order
     * @param _sender The address of the account who is going to pay for the tokens
     * @param _onBehalfOf The address of the account who is going to receive the tokens
     * @param _collateral The address of the collateral token to be deposited
     * @param _depositAmount The amount of collateral token to be deposited
     * @param _minReturnAmountAfterFee The minimum amount of the returned bonded tokens
     */
    function _makeBuyOrder(address _sender, address _onBehalfOf, address _collateral, uint256 _depositAmount, uint256 _minReturnAmountAfterFee)
        internal nonReentrant
    {
        require(_collateralIsWhitelisted(_collateral), ERROR_COLLATERAL_NOT_WHITELISTED);
        require(_collateralValueIsValid(_collateral, _depositAmount), ERROR_INVALID_COLLATERAL_VALUE);

        uint256 fee = _depositAmount.mul(buyFeePct).div(PCT_BASE);
        uint256 depositAmountLessFee = _depositAmount.sub(fee);

        uint256 collateralSupply = token.totalSupply().add(collaterals[_collateral].virtualSupply);
        uint256 collateralBalanceOfReserve = _balanceOf(address(reserve), _collateral).add(collaterals[_collateral].virtualBalance);
        uint32 reserveRatio = collaterals[_collateral].reserveRatio;
        uint256 returnAmount = formula.calculatePurchaseReturn(collateralSupply, collateralBalanceOfReserve, reserveRatio, depositAmountLessFee);

        // collect fee and collateral
        if (_collateral == ETH) {
            bool success = address(reserve).call.value(_depositAmount)();
            require(success, ERROR_TRANSFER_FAILED);
        } else {
            require(ERC20(_collateral).safeTransferFrom(_sender, address(reserve), _depositAmount), ERROR_TRANSFER_FAILED);
        }

        // deduct fee
        if (fee > 0) {
            reserve.transfer(_collateral, beneficiary, fee);
        }

        require(returnAmount >= _minReturnAmountAfterFee, ERROR_SLIPPAGE_EXCEEDS_LIMIT);

        if (returnAmount > 0) {
            tokenManager.mint(_onBehalfOf, returnAmount);
        }

        emit MakeBuyOrder(_sender, _onBehalfOf, _collateral, fee, depositAmountLessFee, returnAmount, buyFeePct);
    }

    /**
     * @dev Make a buy order using makeBuyOrder() function data. Used for single transaction ERC20 buy orders, ones
     *      without a pre-approval transaction, but that have been approved in this transaction.
     * @param _from Token sender
     * @param _token Token that received approval
     * @param _buyOrderData Data for the below function call
     *      makeBuyOrder(address _onBehalfOf, address _collateral, uint256 _depositAmount, uint256 _minReturnAmountAfterFee)
    */
    function _makeBuyOrderRaw(address _from, address _token, uint256 _amount, bytes memory _buyOrderData)
        internal
    {
        // 32 + 4 + 32 + 32 + 32 = 132 (bytes array length + sig + address _onBehalfOf + address _collateral + uint256 _depositAmount)
        require(_buyOrderData.length == 132, ERROR_INVALID_BUY_ORDER_DATA);
        bytes memory buyOrderDataCopy = _buyOrderData;

        bytes4 functionSig;
        address onBehalfOfAddress;
        address collateralTokenAddress;
        uint256 depositAmount;
        uint256 minReturnAmountAfterFee;

        assembly {
            // functionSigByteLocation: 32 (bytes array length)
            functionSig := mload(add(buyOrderDataCopy, 32))

            // onBehalfOfAddressByteLocation: 32 + 4 = 36 (bytes array length + sig)
            onBehalfOfAddress := mload(add(buyOrderDataCopy, 36))

            // collateralAddressByteLocation: 32 + 4 + 32 = 68 (bytes array length + sig + address _onBehalfOf)
            collateralTokenAddress := mload(add(buyOrderDataCopy, 68))

            // depositAmountByteLocation: 32 + 4 + 32 + 32 = 100 (bytes array length + sig + address _onBehalfOf + address _collateral)
            depositAmount := mload(add(buyOrderDataCopy, 100))

            // minReturnAmountAfterFeeByteLocation: 32 + 4 + 32 + 32 + 32 = 132 (bytes array length + sig + address _onBehalfOf + address _collateral + uint256 _depositAmount)
            minReturnAmountAfterFee := mload(add(buyOrderDataCopy, 132))
        }

        require(functionSig == this.makeBuyOrder.selector, ERROR_NOT_BUY_FUNCTION);
        require(onBehalfOfAddress == _from, ERROR_BUYER_NOT_FROM);
        require(collateralTokenAddress == _token, ERROR_COLLATERAL_NOT_SENDER);
        require(depositAmount == _amount, ERROR_DEPOSIT_NOT_AMOUNT);

        _makeBuyOrder(_from, onBehalfOfAddress, collateralTokenAddress, depositAmount, minReturnAmountAfterFee);
    }

    function _updateBeneficiary(address _beneficiary) internal {
        beneficiary = _beneficiary;

        emit UpdateBeneficiary(_beneficiary);
    }

    function _updateFormula(IBancorFormula _formula) internal {
        formula = _formula;

        emit UpdateFormula(address(_formula));
    }

    function _updateFees(uint256 _buyFeePct, uint256 _sellFeePct) internal {
        buyFeePct = _buyFeePct;
        sellFeePct = _sellFeePct;

        emit UpdateFees(_buyFeePct, _sellFeePct);
    }

    function _addCollateralToken(address _collateral, uint256 _virtualSupply, uint256 _virtualBalance, uint32 _reserveRatio)
        internal
    {
        collaterals[_collateral].whitelisted = true;
        collaterals[_collateral].virtualSupply = _virtualSupply;
        collaterals[_collateral].virtualBalance = _virtualBalance;
        collaterals[_collateral].reserveRatio = _reserveRatio;

        emit AddCollateralToken(_collateral, _virtualSupply, _virtualBalance, _reserveRatio);
    }

    function _removeCollateralToken(address _collateral) internal {
        delete collaterals[_collateral];

        emit RemoveCollateralToken(_collateral);
    }

    function _updateCollateralToken(
        address _collateral,
        uint256 _virtualSupply,
        uint256 _virtualBalance,
        uint32  _reserveRatio
    )
        internal
    {
        collaterals[_collateral].virtualSupply = _virtualSupply;
        collaterals[_collateral].virtualBalance = _virtualBalance;
        collaterals[_collateral].reserveRatio = _reserveRatio;

        emit UpdateCollateralToken(_collateral, _virtualSupply, _virtualBalance, _reserveRatio);
    }
}
